import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { uniquePastSlot } from './unique-slot';

/**
 * K2-b (ADR-0069) — uma sessão a faturar, do jeito que o sistema passou a
 * exigir: a consulta já aconteceu (horário no passado) e uma pessoa
 * registrou a realização (POST /appointments/:id/attended). Confirmar a
 * consulta não cria mais sessão; era assim que os testes conseguiam uma.
 */
export interface AttendedSession {
  appointmentId: string;
  sessionId: string;
  scheduledAt: string;
}

export async function attendedSession(
  app: INestApplication,
  token: string,
  params: { patientId: string; therapistId: string; scheduledAt?: string },
): Promise<AttendedSession> {
  const api = () => request(app.getHttpServer());
  const auth = { Authorization: `Bearer ${token}` };
  const scheduledAt = params.scheduledAt ?? uniquePastSlot();
  const appointment = await api()
    .post('/api/v1/appointments')
    .set(auth)
    .send({ patientId: params.patientId, therapistId: params.therapistId, scheduledAt, modality: 'presencial' });
  if (appointment.status !== 201) {
    throw new Error(`consulta recusada (${appointment.status}): ${JSON.stringify(appointment.body)}`);
  }
  const attended = await api().post(`/api/v1/appointments/${appointment.body.id}/attended`).set(auth);
  if (attended.status !== 201 || !attended.body.session?.id) {
    throw new Error(`realização recusada (${attended.status}): ${JSON.stringify(attended.body)}`);
  }
  return { appointmentId: appointment.body.id, sessionId: attended.body.session.id, scheduledAt };
}
