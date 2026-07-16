export function StatCard({ label, value, tone = 'default' }: { label: string; value: string | number; tone?: 'default' | 'gold' }) {
  return (
    <div
      className={tone === 'gold' ? 'luxora-glow' : undefined}
      style={{
        background: '#fff',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        padding: '1.5rem',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <div style={{ position: 'relative', zIndex: 1 }}>
        <p style={{ fontSize: '0.8125rem', color: 'var(--sage)', margin: 0, fontWeight: 600 }}>{label}</p>
        <p
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: '2.25rem',
            margin: '0.25rem 0 0',
            color: tone === 'gold' ? 'var(--gold)' : 'var(--forest)',
          }}
        >
          {value}
        </p>
      </div>
    </div>
  );
}
