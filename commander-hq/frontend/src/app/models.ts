export type Severity = 'OK' | 'WATCH' | 'WARN' | 'CRITICAL' | 'UNKNOWN';

export interface Soldier {
  soldier_id: number;
  callsign: string;
  severity: Severity;
  stale: boolean;
  acked: boolean;
  active_code: number;
  active_label: string;
  interpretation: string;
  hr_bpm: number | null;
  skin_temp_c: number | null;
  activity: number | null;
  gas: number | null;
  x_m: number | null;
  y_m: number | null;
  sector: string | null;
  hops: number | null;
  rssi: number | null;
  psi_est: number | null;
  psi_band: string | null;
  baseline: { hr_bpm: number | null; skin_temp_c: number | null };
  seconds_since_seen: number | null;
  packets: number;
  trail: [number, number][];
}

export interface Alert {
  soldier_id: number;
  callsign: string;
  code: number;
  label: string;
  interpretation: string;
  severity: Severity;
  sector: string;
  t_s: number;
  hr_bpm: number;
  hops: number;
  rssi: number | null;
}

export interface SquadEvent {
  kind: 'POSSIBLE_CONTACT' | 'HAZARD_AREA';
  sector: string;
  soldier_ids: number[];
  t_s: number;
  detail: string;
}

export interface Briefing {
  text: string;
  source: 'llm' | 'template';
  model: string | null;
  latency_ms: number;
  trigger: string;
  mission_time_s: number;
  note: string | null;
}

export interface C2State {
  mission_time_s: number;
  soldiers: Soldier[];
  alerts: Alert[];
  squad_events: SquadEvent[];
  counts: Partial<Record<Severity, number>>;
  stats: { packets: number; bytes: number; rejected: number; alerts: number; checkins: number };
  grid: { size_m: number; n: number };
  source: 'sim' | 'serial';
  emission: { sensor_samples: number; packets_on_air: number; radio_silence_pct: number } | null;
  briefings: Briefing[];
  llm: { enabled: boolean; reachable: boolean | null; model: string; base_url: string };
}
