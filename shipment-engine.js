const HOURLY_MOVEMENT_MS = 60 * 60 * 1000;
const MICRO_LOCATION_MS = 4 * HOURLY_MOVEMENT_MS;

const CORRIDOR_PREFIXES = ['Transit Corridor', 'Cargo Route', 'Logistics Channel', 'Freight Vector', 'Relay Passage', 'Distribution Arc'];
const CORRIDOR_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const MOVEMENT_NOTES = [
  'Moving through a secured relay corridor.',
  'Shipment advancing through the automated freight lane.',
  'Cargo progressing inside the managed transit stream.',
  'Shipment routed through a monitored transfer channel.',
  'Consignment continuing through the dynamic logistics lane.'
];

function normalizeStatus(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 'processing';
  if (['processing', 'pending'].includes(raw)) return 'processing';
  if (['departed', 'confirmed'].includes(raw)) return 'confirmed';
  if (['in transit', 'in_transit'].includes(raw)) return 'in_transit';
  if (['arrived at facility', 'arrived_at_facility', 'customs', 'customs review'].includes(raw)) return 'customs';
  if (['out for delivery', 'out_for_delivery'].includes(raw)) return 'out_for_delivery';
  if (raw === 'delivered') return 'delivered';
  if (raw === 'paused') return 'paused';
  if (raw === 'deleted') return 'deleted';
  return raw.replace(/\s+/g, '_');
}

function statusLabel(status) {
  const normalized = normalizeStatus(status);
  const labels = {
    processing: 'Processing',
    confirmed: 'Departed',
    in_transit: 'In Transit',
    customs: 'Arrived at Facility',
    out_for_delivery: 'Out for Delivery',
    delivered: 'Delivered',
    paused: 'Paused',
    deleted: 'Deleted'
  };
  return labels[normalized] || String(status || 'Processing');
}

function createMajorPipeline(origin, destination) {
  const safeOrigin = String(origin || 'Origin').trim() || 'Origin';
  const safeDestination = String(destination || 'Destination').trim() || 'Destination';
  return [
    {
      event_type: 'major',
      location: `${safeOrigin} Origin Facility`,
      status: 'processing',
      note: 'Shipment received and registered at the origin facility.',
      major_step_index: 0,
      major_step_label: 'Origin Facility'
    },
    {
      event_type: 'major',
      location: 'Central Dispatch Hub',
      status: 'confirmed',
      note: 'Shipment dispatched from origin into the central routing network.',
      major_step_index: 1,
      major_step_label: 'Central Dispatch Hub'
    },
    {
      event_type: 'major',
      location: 'Regional Sorting Center',
      status: 'in_transit',
      note: 'Shipment sorted for regional transit progression.',
      major_step_index: 2,
      major_step_label: 'Regional Sorting Center'
    },
    {
      event_type: 'major',
      location: 'International Transit Hub',
      status: 'in_transit',
      note: 'Shipment routed through the international transit exchange.',
      major_step_index: 3,
      major_step_label: 'International Transit Hub'
    },
    {
      event_type: 'major',
      location: 'Logistics Processing Facility',
      status: 'customs',
      note: 'Shipment entered logistics processing and compliance handling.',
      major_step_index: 4,
      major_step_label: 'Logistics Processing Facility'
    },
    {
      event_type: 'major',
      location: 'Distribution Center',
      status: 'in_transit',
      note: 'Shipment transferred to downstream distribution operations.',
      major_step_index: 5,
      major_step_label: 'Distribution Center'
    },
    {
      event_type: 'major',
      location: 'Destination Processing Center',
      status: 'out_for_delivery',
      note: 'Shipment prepared for destination-area final delivery release.',
      major_step_index: 6,
      major_step_label: 'Destination Processing Center'
    },
    {
      event_type: 'major',
      location: `${safeDestination} Final Delivery Hub`,
      status: 'delivered',
      note: 'Shipment delivered successfully at the final delivery hub.',
      major_step_index: 7,
      major_step_label: 'Final Delivery Hub'
    }
  ];
}

function createMicroLocation(segmentIndex, microIndex) {
  const prefix = CORRIDOR_PREFIXES[(segmentIndex + microIndex) % CORRIDOR_PREFIXES.length];
  const letterA = CORRIDOR_LETTERS[(segmentIndex * 3 + microIndex * 5) % CORRIDOR_LETTERS.length];
  const letterB = CORRIDOR_LETTERS[(segmentIndex * 7 + microIndex * 2 + 4) % CORRIDOR_LETTERS.length];
  const code = `${letterA}-${String(((segmentIndex + 1) * 11) + microIndex * 7).padStart(2, '0')}${letterB}`;
  const note = MOVEMENT_NOTES[(segmentIndex + microIndex) % MOVEMENT_NOTES.length];
  return {
    location: `In Transit (via ${prefix} ${code})`,
    status: 'in_transit',
    note
  };
}

function toIso(value, fallback = new Date()) {
  const date = value ? new Date(value) : new Date(fallback);
  if (Number.isNaN(date.getTime())) return new Date(fallback).toISOString();
  return date.toISOString();
}

function ensureFutureDeadline(startAt, deliveryDeadline) {
  const start = new Date(startAt);
  const end = new Date(deliveryDeadline);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error('A valid delivery deadline is required to build the shipment movement plan.');
  }
  if (end.getTime() <= start.getTime()) {
    throw new Error('Expected delivery date must be later than the shipment start time.');
  }
  return { start, end };
}

function buildScheduledMovementPlan({ origin, destination, startAt, deliveryDeadline }) {
  const { start, end } = ensureFutureDeadline(startAt, deliveryDeadline);
  const majorPipeline = createMajorPipeline(origin, destination);
  const totalDurationMs = end.getTime() - start.getTime();
  const majorIntervalMs = totalDurationMs / (majorPipeline.length - 1);
  const events = [];

  majorPipeline.forEach((majorStep, index) => {
    const majorTime = new Date(start.getTime() + majorIntervalMs * index);
    events.push({
      ...majorStep,
      scheduled_for: majorTime.toISOString()
    });

    if (index >= majorPipeline.length - 1) return;

    const nextMajorTime = new Date(start.getTime() + majorIntervalMs * (index + 1));
    let microCursor = majorTime.getTime() + MICRO_LOCATION_MS;
    let microIndex = 0;

    while (microCursor < nextMajorTime.getTime() - 60 * 1000) {
      const micro = createMicroLocation(index, microIndex);
      events.push({
        event_type: 'micro',
        location: micro.location,
        status: micro.status,
        note: micro.note,
        major_step_index: majorStep.major_step_index,
        major_step_label: majorStep.major_step_label,
        scheduled_for: new Date(microCursor).toISOString()
      });
      microIndex += 1;
      microCursor += MICRO_LOCATION_MS;
    }
  });

  events.sort((a, b) => new Date(a.scheduled_for) - new Date(b.scheduled_for));
  const totalEvents = events.length;
  const indexed = events.map((event, eventIndex) => ({
    ...event,
    event_index: eventIndex,
    progress_percent: totalEvents <= 1 ? 100 : Math.round((eventIndex / (totalEvents - 1)) * 100)
  }));

  return {
    plan: indexed,
    totalEvents,
    nextMovementAt: getNextEventTime(indexed, 0, 'major'),
    nextSimulationAt: getNextEventTime(indexed, 0, 'micro'),
    deliveryDeadline: end.toISOString(),
    startAt: start.toISOString(),
    stepIntervalHours: Number((totalDurationMs / Math.max(totalEvents - 1, 1) / HOURLY_MOVEMENT_MS).toFixed(2))
  };
}

function getNextEvent(plan, currentEventIndex = 0, type = 'any') {
  const safePlan = Array.isArray(plan) ? plan : [];
  for (let index = Number(currentEventIndex || 0) + 1; index < safePlan.length; index += 1) {
    const candidate = safePlan[index];
    if (!candidate) continue;
    if (type === 'any' || candidate.event_type === type) return candidate;
  }
  return null;
}

function getNextEventTime(plan, currentEventIndex = 0, type = 'any') {
  return getNextEvent(plan, currentEventIndex, type)?.scheduled_for || null;
}

function shiftFutureEvents(plan, currentEventIndex = 0, delayMs = 0) {
  const safeDelay = Math.max(Number(delayMs || 0), 0);
  return (Array.isArray(plan) ? plan : []).map((event, index) => {
    if (index <= Number(currentEventIndex || 0) || !safeDelay) return { ...event };
    return {
      ...event,
      scheduled_for: new Date(new Date(event.scheduled_for).getTime() + safeDelay).toISOString()
    };
  });
}

function getDeliveryEta(plan) {
  const safePlan = Array.isArray(plan) ? plan : [];
  return safePlan.length ? safePlan[safePlan.length - 1].scheduled_for : null;
}

function getCurrentEvent(plan, currentEventIndex = 0) {
  const safePlan = Array.isArray(plan) ? plan : [];
  if (!safePlan.length) return null;
  return safePlan[Math.max(0, Math.min(Number(currentEventIndex || 0), safePlan.length - 1))] || null;
}

module.exports = {
  HOURLY_MOVEMENT_MS,
  MICRO_LOCATION_MS,
  normalizeStatus,
  statusLabel,
  createMajorPipeline,
  buildScheduledMovementPlan,
  getNextEvent,
  getNextEventTime,
  shiftFutureEvents,
  getDeliveryEta,
  getCurrentEvent
};
