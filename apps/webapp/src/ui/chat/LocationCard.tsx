/**
 * A shared location, rendered as a card — pin glyph, name, coordinates and an
 * "Open in maps" link to OpenStreetMap. No tiles, no send flow: parity with
 * the phones' static card, minus the map preview.
 *
 * The wire shape (sendMessageBody.location / messages.location) is
 * `{latitude, longitude, name, liveUntil}`; the client-wide Message type
 * still says `{lat, lng, label}`, so both spellings are accepted here.
 */

import { MapPinIcon } from './icons-local';

interface LocationWire {
  latitude?: number;
  longitude?: number;
  lat?: number;
  lng?: number;
  name?: string | null;
  label?: string | null;
  liveUntil?: string | null;
}

export function LocationCard(props: { location: unknown }) {
  const loc = props.location as LocationWire;
  const lat = loc.latitude ?? loc.lat;
  const lng = loc.longitude ?? loc.lng;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;

  const label = loc.name ?? loc.label ?? null;
  const coords = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  const href = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=16/${lat}/${lng}`;
  const live = loc.liveUntil ? Date.parse(loc.liveUntil) > Date.now() : false;

  return (
    <div className="location-card">
      <div className="location-pin">
        <MapPinIcon size={20} />
      </div>
      <div className="location-body">
        <div className="location-name">{label || 'Location'}</div>
        <div className="location-coords">
          {coords}
          {live ? ' · live' : ''}
        </div>
        <a className="location-open" href={href} target="_blank" rel="noreferrer noopener">
          Open in maps
        </a>
      </div>
    </div>
  );
}
