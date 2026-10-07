'use client';

import { useState } from 'react';
import { PageShell, cardStyle, hintStyle, inputStyle, labelStyle, rowStyle, sectionTitleStyle } from '@/components/ui/page-shell';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, EmptyState, ErrorMessage, Loading, SuccessMessage } from '@/components/ui/feedback';
import { describeApiError } from '@/lib/api-client/errors';
import { useCurrentUserId, useRole, type Role } from '@/lib/session';
import { useTherapists } from '@/lib/api-client/therapists.hooks';
import { type ClinicUser, useCreateUser, useDeactivateUser, useReactivateUser, useUsers } from '@/lib/api-client/users.hooks';

const ROLE_LABELS: Record<Role, string> = { admin: 'Administrador', therapist: 'Terapeuta' };

/**
 * UsuariosPage — Tarefa 05 da auditoria. Quem tem acesso ao painel: listar,
 * dar acesso (criar), tirar acesso (desativar) e devolver (reativar).
 * Só para admin, como na API.
 */
export default function UsuariosPage() {
  const role = useRole();
  const currentUserId = useCurrentUserId();
  const isAdmin = role !== 'therapist';
  const { data, isLoading, isError, error } = useUsers(isAdmin);
  const { data: therapistsData } = useTherapists();
  const deactivate = useDeactivateUser();
  const reactivate = useReactivateUser();
  const [showForm, setShowForm] = useState(false);
  const [toDeactivate, setToDeactivate] = useState<ClinicUser | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const users = data?.data ?? [];
  const therapists = therapistsData?.data ?? [];
  const therapistName = (id: string | null) => therapists.find((therapist) => therapist.id === id)?.name;

  if (!isAdmin) {
    return (
      <PageShell title="Usuários" maxWidth="760px">
        <EmptyState>A gestão de usuários é restrita a administradores da clínica.</EmptyState>
      </PageShell>
    );
  }

  async function handleDeactivate() {
    if (!toDeactivate) return;
    setDialogError(null);
    try {
      await deactivate.mutateAsync(toDeactivate.id);
      setSuccess(`${toDeactivate.email} não tem mais acesso ao painel.`);
      setToDeactivate(null);
    } catch (err) {
      setDialogError(describeApiError(err, 'Não foi possível desativar o usuário.'));
    }
  }

  async function handleReactivate(user: ClinicUser) {
    setActionError(null);
    setSuccess(null);
    try {
      await reactivate.mutateAsync(user.id);
      setSuccess(`${user.email} voltou a ter acesso ao painel.`);
    } catch (err) {
      setActionError(describeApiError(err, 'Não foi possível reativar o usuário.'));
    }
  }

  return (
    <PageShell
      title="Usuários"
      maxWidth="760px"
      actions={
        <Button
          onClick={() => {
            setSuccess(null);
            setActionError(null);
            setShowForm((visible) => !visible);
          }}
        >
          {showForm ? 'Fechar' : 'Novo usuário'}
        </Button>
      }
    >
      {showForm && (
        <UserForm
          therapists={therapists}
          onCreated={(user) => {
            setShowForm(false);
            setSuccess(`Acesso criado para ${user.email}.`);
          }}
        />
      )}

      {isLoading && <Loading />}
      {isError && <ErrorMessage>{describeApiError(error, 'Não foi possível carregar os usuários.')}</ErrorMessage>}
      <ErrorMessage>{actionError}</ErrorMessage>
      <SuccessMessage>{success}</SuccessMessage>

      <ul style={{ listStyle: 'none', padding: 0 }}>
        {users.map((user) => {
          const isSelf = user.id === currentUserId;
          const reactivating = reactivate.isPending && reactivate.variables === user.id;
          return (
            <li key={user.id} style={{ ...rowStyle, opacity: user.isActive ? 1 : 0.7 }}>
              <div>
                <p style={{ margin: 0, fontWeight: 600 }}>
                  {user.email}
                  {isSelf && ' (você)'}
                </p>
                <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--sage)' }}>
                  {ROLE_LABELS[user.role] ?? user.role}
                  {user.therapistId && ` · ${therapistName(user.therapistId) ?? 'terapeuta vinculado'}`}
                  {!user.isActive && ' · sem acesso'}
                </p>
              </div>
              {user.isActive && !isSelf && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setSuccess(null);
                    setDialogError(null);
                    setToDeactivate(user);
                  }}
                >
                  Desativar
                </Button>
              )}
              {!user.isActive && (
                <Button type="button" variant="ghost" disabled={reactivating} onClick={() => handleReactivate(user)}>
                  {reactivating ? 'Reativando...' : 'Reativar'}
                </Button>
              )}
            </li>
          );
        })}
      </ul>

      {toDeactivate && (
        <ConfirmDialog
          title="Desativar este usuário?"
          description={
            <>
              {toDeactivate.email} perde o acesso ao painel: não consegue mais entrar nem renovar a sessão que já tem aberta. Os registros feitos por
              essa pessoa continuam no sistema, e o acesso pode ser devolvido depois.
            </>
          }
          confirmLabel="Desativar usuário"
          busyLabel="Desativando..."
          busy={deactivate.isPending}
          error={dialogError}
          onConfirm={handleDeactivate}
          onCancel={() => setToDeactivate(null)}
        />
      )}
    </PageShell>
  );
}

function UserForm(props: { therapists: Array<{ id: string; name: string }>; onCreated: (user: ClinicUser) => void }) {
  const createUser = useCreateUser();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('therapist');
  const [therapistId, setTherapistId] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (password.length < 8) return setError('A senha precisa ter ao menos 8 caracteres.');
    if (role === 'therapist' && !therapistId) return setError('Escolha a qual terapeuta este acesso pertence.');
    setError(null);
    try {
      // therapistId só acompanha o papel "therapist" — o backend recusa admin com terapeuta vinculado.
      props.onCreated(await createUser.mutateAsync({ email, password, role, ...(role === 'therapist' ? { therapistId } : {}) }));
    } catch (err) {
      setError(describeApiError(err, 'Não foi possível criar o usuário. Confira o e-mail e a senha.'));
    }
  }

  return (
    <form onSubmit={handleSubmit} style={cardStyle} aria-label="Novo usuário">
      <h2 style={sectionTitleStyle}>Novo usuário</h2>

      <label style={labelStyle} htmlFor="user-email">
        E-mail
      </label>
      <input id="user-email" type="email" required autoComplete="off" value={email} onChange={(event) => setEmail(event.target.value)} style={inputStyle} />

      <label style={labelStyle} htmlFor="user-password">
        Senha inicial
      </label>
      <input id="user-password" type="password" required minLength={8} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} style={inputStyle} />
      <p style={hintStyle}>Ao menos 8 caracteres. Entregue a senha à pessoa por um canal seguro.</p>

      <label style={labelStyle} htmlFor="user-role">
        Perfil
      </label>
      <select id="user-role" value={role} onChange={(event) => setRole(event.target.value as Role)} style={inputStyle}>
        <option value="therapist">Terapeuta — agenda, pacientes e consulta ao financeiro</option>
        <option value="admin">Administrador — tudo, inclusive cobranças, usuários e configurações</option>
      </select>

      {role === 'therapist' && (
        <>
          <label style={labelStyle} htmlFor="user-therapist">
            Terapeuta vinculado
          </label>
          <select id="user-therapist" value={therapistId} onChange={(event) => setTherapistId(event.target.value)} style={inputStyle}>
            <option value="">Selecione...</option>
            {props.therapists.map((therapist) => (
              <option key={therapist.id} value={therapist.id}>
                {therapist.name}
              </option>
            ))}
          </select>
          {props.therapists.length === 0 && <p style={hintStyle}>Cadastre o terapeuta em Terapeutas antes de criar o acesso dele.</p>}
        </>
      )}

      <ErrorMessage>{error}</ErrorMessage>
      <Button type="submit" disabled={createUser.isPending} style={{ marginTop: '1rem' }}>
        {createUser.isPending ? 'Criando...' : 'Criar usuário'}
      </Button>
    </form>
  );
}
