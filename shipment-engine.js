const HOURLY_MOVEMENT_MS = 60 * 60 * 1000;
const MICRO_LOCATION_MS = HOURLY_MOVEMENT_MS;

const COUNTRY_ALIASES = {
  usa: 'United States',
  us: 'United States',
  'u.s.a': 'United States',
  'u.s.': 'United States',
  america: 'United States',
  'united states of america': 'United States',
  uk: 'United Kingdom',
  uae: 'United Arab Emirates',
  holland: 'Netherlands',
  russia: 'Russia',
  korea: 'South Korea',
  'south korea': 'South Korea',
  'north korea': 'North Korea',
  czechia: 'Czech Republic'
};

const CONTINENT_BY_COUNTRY = {
  'United States': 'North America',
  Canada: 'North America',
  Mexico: 'North America',
  Brazil: 'South America',
  Argentina: 'South America',
  Chile: 'South America',
  Colombia: 'South America',
  Peru: 'South America',
  'United Kingdom': 'Europe',
  Ireland: 'Europe',
  France: 'Europe',
  Spain: 'Europe',
  Portugal: 'Europe',
  Germany: 'Europe',
  Netherlands: 'Europe',
  Belgium: 'Europe',
  Luxembourg: 'Europe',
  Italy: 'Europe',
  Switzerland: 'Europe',
  Austria: 'Europe',
  Denmark: 'Europe',
  Norway: 'Europe',
  Sweden: 'Europe',
  Finland: 'Europe',
  Poland: 'Europe',
  'Czech Republic': 'Europe',
  Hungary: 'Europe',
  Romania: 'Europe',
  Greece: 'Europe',
  Turkey: 'Europe',
  Ukraine: 'Europe',
  Russia: 'Europe',
  Morocco: 'Africa',
  Egypt: 'Africa',
  Nigeria: 'Africa',
  Kenya: 'Africa',
  Ghana: 'Africa',
  'South Africa': 'Africa',
  Tanzania: 'Africa',
  Uganda: 'Africa',
  Ethiopia: 'Africa',
  China: 'Asia',
  Japan: 'Asia',
  India: 'Asia',
  Pakistan: 'Asia',
  Bangladesh: 'Asia',
  Thailand: 'Asia',
  Vietnam: 'Asia',
  Malaysia: 'Asia',
  Singapore: 'Asia',
  Indonesia: 'Asia',
  Philippines: 'Asia',
  'South Korea': 'Asia',
  'North Korea': 'Asia',
  Taiwan: 'Asia',
  'Hong Kong': 'Asia',
  'United Arab Emirates': 'Asia',
  Qatar: 'Asia',
  'Saudi Arabia': 'Asia',
  Israel: 'Asia',
  Jordan: 'Asia',
  Australia: 'Oceania',
  'New Zealand': 'Oceania'
};

const COUNTRY_GATEWAYS = {
  'United States': 'New York',
  Canada: 'Toronto',
  Mexico: 'Mexico City',
  Brazil: 'São Paulo',
  Argentina: 'Buenos Aires',
  Chile: 'Santiago',
  Colombia: 'Bogotá',
  Peru: 'Lima',
  'United Kingdom': 'London',
  Ireland: 'Dublin',
  France: 'Paris',
  Spain: 'Madrid',
  Portugal: 'Lisbon',
  Germany: 'Frankfurt',
  Netherlands: 'Amsterdam',
  Belgium: 'Brussels',
  Italy: 'Milan',
  Switzerland: 'Zurich',
  Denmark: 'Copenhagen',
  Norway: 'Oslo',
  Sweden: 'Stockholm',
  Poland: 'Warsaw',
  Turkey: 'Istanbul',
  Russia: 'Moscow',
  Morocco: 'Casablanca',
  Egypt: 'Cairo',
  Nigeria: 'Lagos',
  Kenya: 'Nairobi',
  Ghana: 'Accra',
  'South Africa': 'Johannesburg',
  China: 'Shanghai',
  Japan: 'Tokyo',
  India: 'Mumbai',
  Pakistan: 'Karachi',
  Bangladesh: 'Dhaka',
  Thailand: 'Bangkok',
  Vietnam: 'Ho Chi Minh City',
  Malaysia: 'Kuala Lumpur',
  Singapore: 'Singapore',
  Indonesia: 'Jakarta',
  Philippines: 'Manila',
  'South Korea': 'Seoul',
  Taiwan: 'Taipei',
  'Hong Kong': 'Hong Kong',
  'United Arab Emirates': 'Dubai',
  Qatar: 'Doha',
  'Saudi Arabia': 'Jeddah',
  Israel: 'Tel Aviv',
  Australia: 'Sydney',
  'New Zealand': 'Auckland'
};

const BRIDGE_COUNTRIES = {
  'Europe>North America': ['Spain', 'United Kingdom'],
  'North America>Europe': ['Canada', 'Ireland'],
  'Europe>Asia': ['Turkey', 'United Arab Emirates'],
  'Asia>Europe': ['United Arab Emirates', 'Turkey'],
  'Asia>North America': ['Japan', 'United States'],
  'North America>Asia': ['United States', 'Japan'],
  'Europe>Africa': ['Spain', 'Morocco'],
  'Africa>Europe': ['Morocco', 'Spain'],
  'Africa>North America': ['Morocco', 'Spain', 'United States'],
  'North America>Africa': ['United States', 'Spain', 'Morocco'],
  'Asia>Africa': ['United Arab Emirates', 'Egypt'],
  'Africa>Asia': ['Egypt', 'United Arab Emirates'],
  'Oceania>Asia': ['Singapore'],
  'Asia>Oceania': ['Singapore'],
  'Oceania>North America': ['Singapore', 'United States'],
  'North America>Oceania': ['United States', 'Singapore'],
  'Europe>Oceania': ['United Arab Emirates', 'Singapore'],
  'Oceania>Europe': ['Singapore', 'United Arab Emirates'],
  'South America>North America': ['Mexico', 'United States'],
  'North America>South America': ['Mexico', 'Brazil'],
  'South America>Europe': ['Brazil', 'Portugal'],
  'Europe>South America': ['Portugal', 'Brazil']
};

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
    processing: 'Pending',
    confirmed: 'Departed',
    in_transit: 'In Transit',
    customs: 'Arrived at Facility',
    out_for_delivery: 'Out for Delivery',
    delivered: 'Delivered',
    paused: 'Paused',
    deleted: 'Deleted'
  };
  return labels[normalized] || String(status || 'Pending');
}

function titleCaseToken(value = '') {
  return String(value || '')
    .split(/\s+/)
    .filter(Boolean)
    .map(token => token.charAt(0).toUpperCase() + token.slice(1).toLowerCase())
    .join(' ');
}

function normalizeCountry(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const alias = COUNTRY_ALIASES[raw.toLowerCase()];
  if (alias) return alias;
  const titleCased = titleCaseToken(raw);
  return COUNTRY_ALIASES[titleCased.toLowerCase()] || titleCased;
}

function inferCountryFromRegion(region = '') {
  const raw = String(region || '').trim().toLowerCase();
  if (!raw) return '';
  const usStates = new Set([
    'alabama','alaska','arizona','arkansas','california','colorado','connecticut','delaware','florida','georgia','hawaii',
    'idaho','illinois','indiana','iowa','kansas','kentucky','louisiana','maine','maryland','massachusetts','michigan',
    'minnesota','mississippi','missouri','montana','nebraska','nevada','new hampshire','new jersey','new mexico','new york',
    'north carolina','north dakota','ohio','oklahoma','oregon','pennsylvania','rhode island','south carolina','south dakota',
    'tennessee','texas','utah','vermont','virginia','washington','west virginia','wisconsin','wyoming',
    'district of columbia'
  ]);
  if (usStates.has(raw)) return 'United States';
  return '';
}

function parseLocationParts(input = '') {
  const safe = String(input || '').trim();
  if (!safe) return { raw: '', city: '', region: '', country: '', continent: '' };

  const parts = safe.split(',').map(part => part.trim()).filter(Boolean);
  if (parts.length === 1) {
    const countryOnly = normalizeCountry(parts[0]);
    if (CONTINENT_BY_COUNTRY[countryOnly]) {
      return { raw: safe, city: '', region: '', country: countryOnly, continent: CONTINENT_BY_COUNTRY[countryOnly] || '' };
    }
    return { raw: safe, city: safe, region: '', country: '', continent: '' };
  }

  const city = parts[0] || '';
  const countryCandidate = normalizeCountry(parts[parts.length - 1] || '');
  const hasCountry = Boolean(CONTINENT_BY_COUNTRY[countryCandidate] || countryCandidate);
  const region = parts.length >= 3 ? parts[parts.length - 2] : '';
  const country = hasCountry ? countryCandidate : inferCountryFromRegion(parts[parts.length - 1] || '');
  const effectiveRegion = region || (!hasCountry ? parts[parts.length - 1] : '');
  return {
    raw: safe,
    city,
    region: effectiveRegion,
    country,
    continent: CONTINENT_BY_COUNTRY[country] || ''
  };
}

function uniquePush(list, value) {
  const safe = String(value || '').trim();
  if (!safe) return;
  if (list[list.length - 1] === safe) return;
  if (!list.includes(safe)) list.push(safe);
}

function buildTransitCountries(origin, destination) {
  const originContinent = origin.continent || '';
  const destinationContinent = destination.continent || '';
  const corridorKey = `${originContinent}>${destinationContinent}`;
  const corridor = BRIDGE_COUNTRIES[corridorKey] || [];
  const countries = [];
  for (const country of corridor) {
    if (country !== origin.country && country !== destination.country) uniquePush(countries, country);
  }
  return countries;
}

function buildRouteWaypoints(originInput, destinationInput) {
  const origin = parseLocationParts(originInput);
  const destination = parseLocationParts(destinationInput);
  const waypoints = [];

  uniquePush(waypoints, origin.city || origin.raw || origin.country || 'Origin');
  if (origin.region && origin.region !== origin.city) uniquePush(waypoints, origin.region);
  if (origin.country) uniquePush(waypoints, origin.country);

  if (origin.country && destination.country && origin.country !== destination.country) {
    buildTransitCountries(origin, destination).forEach(country => uniquePush(waypoints, country));
    uniquePush(waypoints, destination.country);
    const destinationEntry = COUNTRY_GATEWAYS[destination.country] || '';
    if (destinationEntry && destinationEntry !== destination.city) uniquePush(waypoints, destinationEntry);
  } else if (origin.country && destination.country && origin.country === destination.country) {
    const domesticGateway = COUNTRY_GATEWAYS[destination.country] || COUNTRY_GATEWAYS[origin.country] || '';
    if (domesticGateway && domesticGateway !== origin.city && domesticGateway !== destination.city) {
      uniquePush(waypoints, domesticGateway);
    }
  }

  if (destination.region && destination.region !== destination.city && destination.region !== destination.country) {
    uniquePush(waypoints, destination.region);
  }
  uniquePush(waypoints, destination.city || destination.raw || destination.country || 'Destination');

  return waypoints.filter(Boolean);
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

function createMajorPipeline(origin, destination) {
  return buildRouteWaypoints(origin, destination).map((location, index, list) => {
    const lastIndex = list.length - 1;
    const secondLastIndex = Math.max(lastIndex - 1, 0);
    let status = 'in_transit';
    let note = `Shipment progressed through ${location}.`;

    if (index === 0) {
      status = 'processing';
      note = `Shipment registered and queued for dispatch from ${location}.`;
    } else if (index === 1) {
      status = 'confirmed';
      note = `Shipment departed origin routing chain and advanced to ${location}.`;
    } else if (index === secondLastIndex && index !== lastIndex) {
      status = 'out_for_delivery';
      note = `Shipment entered destination delivery zone through ${location}.`;
    } else if (index === lastIndex) {
      status = 'delivered';
      note = `Shipment delivered successfully at ${location}.`;
    } else if (index >= Math.floor(lastIndex / 2)) {
      status = 'customs';
      note = `Shipment cleared destination-side routing and compliance handling at ${location}.`;
    }

    return {
      event_type: 'major',
      location,
      status,
      note,
      major_step_index: index,
      major_step_label: location
    };
  });
}

function createMicroLocation(from, to, microIndex, segmentHours) {
  const phaseLabels = ['Departed', 'Advancing toward', 'Approaching', 'Near'];
  const phase = phaseLabels[Math.min(microIndex, phaseLabels.length - 1)] || 'Advancing toward';
  const note = `Shipment is progressing from ${from} toward ${to}.`;
  return {
    location: `${phase} ${to}`,
    status: segmentHours - microIndex <= 2 ? 'customs' : 'in_transit',
    note
  };
}

function buildScheduledMovementPlan({ origin, destination, startAt, deliveryDeadline }) {
  const { start, end } = ensureFutureDeadline(startAt, deliveryDeadline);
  const majorPipeline = createMajorPipeline(origin, destination);
  const segmentCount = Math.max(majorPipeline.length - 1, 1);
  const requestedHours = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / HOURLY_MOVEMENT_MS));
  const totalHourlySteps = Math.max(requestedHours, segmentCount);
  const baseHoursPerSegment = Math.floor(totalHourlySteps / segmentCount);
  const remainder = totalHourlySteps % segmentCount;

  const events = [];
  let cursorMs = start.getTime();
  events.push({
    ...majorPipeline[0],
    scheduled_for: new Date(cursorMs).toISOString()
  });

  for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
    const from = majorPipeline[segmentIndex]?.location || 'Origin';
    const to = majorPipeline[segmentIndex + 1]?.location || 'Destination';
    const segmentHours = baseHoursPerSegment + (segmentIndex < remainder ? 1 : 0);

    for (let hourIndex = 1; hourIndex < segmentHours; hourIndex += 1) {
      cursorMs += HOURLY_MOVEMENT_MS;
      const micro = createMicroLocation(from, to, hourIndex, segmentHours);
      events.push({
        event_type: 'micro',
        location: micro.location,
        status: micro.status,
        note: micro.note,
        major_step_index: majorPipeline[segmentIndex].major_step_index,
        major_step_label: majorPipeline[segmentIndex].major_step_label,
        scheduled_for: new Date(cursorMs).toISOString()
      });
    }

    cursorMs += HOURLY_MOVEMENT_MS;
    events.push({
      ...majorPipeline[segmentIndex + 1],
      scheduled_for: new Date(cursorMs).toISOString()
    });
  }

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
    deliveryDeadline: new Date(cursorMs).toISOString(),
    startAt: start.toISOString(),
    stepIntervalHours: 1
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
  getCurrentEvent,
  toIso,
  parseLocationParts,
  buildRouteWaypoints
};
