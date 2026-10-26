import { rows, type Sql } from './db.js';
import { iso, json } from './models.js';

export function pricingSnapshot(service: {
  unitLabel: string;
  unitPriceCents: number;
  minimumChargeCents: number;
  basePriceCents: number;
}) {
  return {
    unitLabel: service.unitLabel,
    unit: service.unitPriceCents,
    minimum: service.minimumChargeCents,
    base: service.basePriceCents,
  };
}
export async function teachingState(businessId: string, serviceId: string, connection?: Sql) {
  const [service] = await rows(
    'SELECT teaching_revision FROM services WHERE business_id=? AND id=?',
    [businessId, serviceId],
    connection,
  );
  const notes = await rows(
    'SELECT * FROM service_teaching_notes WHERE business_id=? AND service_id=? ORDER BY revision',
    [businessId, serviceId],
    connection,
  );
  return {
    revision: Number(service?.teaching_revision || 0),
    notes: notes.map((note) => ({
      id: String(note.id),
      content: String(note.content),
      createdAt: iso(note.created_at),
    })),
    pricingSnapshots: notes.map((note) =>
      json<ReturnType<typeof pricingSnapshot>>(note.pricing_snapshot_json, {
        unitLabel: '',
        unit: 0,
        minimum: 0,
        base: 0,
      }),
    ),
    pricingBaseline: notes.length
      ? json<Record<string, unknown>>(notes.at(-1)!.pricing_snapshot_json, {})
      : undefined,
  };
}
export function publicTeaching(state: Awaited<ReturnType<typeof teachingState>>) {
  return { revision: state.revision, notes: state.notes };
}
