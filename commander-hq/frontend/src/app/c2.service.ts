import { Injectable, computed, signal } from '@angular/core';
import { Briefing, C2State } from './models';

/** Backend location: same origin when served by FastAPI, :8000 during `ng serve`. */
function backendBase(): { http: string; ws: string } {
  const { protocol, hostname, port, host } = window.location;
  const h = port === '4200' ? `${hostname}:8000` : host;
  return { http: `${protocol}//${h}`, ws: `${protocol === 'https:' ? 'wss' : 'ws'}://${h}/ws` };
}

@Injectable({ providedIn: 'root' })
export class C2Service {
  private readonly base = backendBase();
  private socket?: WebSocket;
  private retry?: ReturnType<typeof setTimeout>;

  readonly state = signal<C2State | null>(null);
  readonly connected = signal(false);
  readonly latestBriefing = signal<Briefing | null>(null);
  readonly briefingBusy = signal(false);

  readonly soldiers = computed(() => this.state()?.soldiers ?? []);
  readonly flagged = computed(() =>
    this.soldiers().filter((s) => s.severity !== 'OK').length,
  );

  connect(): void {
    clearTimeout(this.retry);
    const ws = new WebSocket(this.base.ws);
    this.socket = ws;
    ws.onopen = () => this.connected.set(true);
    ws.onclose = () => {
      this.connected.set(false);
      this.retry = setTimeout(() => this.connect(), 1500);
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'state') {
        this.state.set(msg.state);
        if (!this.latestBriefing() && msg.state.briefings?.length) {
          this.latestBriefing.set(msg.state.briefings[0]);
        }
      } else if (msg.type === 'briefing') {
        this.latestBriefing.set(msg.briefing);
      }
    };
  }

  private post(path: string, body?: unknown): Promise<Response> {
    return fetch(`${this.base.http}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async scenario(name: string): Promise<void> {
    await this.post('/api/scenario', { name });
    if (name === 'reset') this.latestBriefing.set(null);
  }

  ack(soldierId: number): Promise<Response> {
    return this.post(`/api/soldiers/${soldierId}/ack`);
  }

  async briefNow(): Promise<void> {
    this.briefingBusy.set(true);
    try {
      const r = await this.post('/api/briefing');
      this.latestBriefing.set(await r.json());
    } finally {
      this.briefingBusy.set(false);
    }
  }
}
