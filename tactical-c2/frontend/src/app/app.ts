import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { C2Service } from './c2.service';
import { CopMap } from './cop-map';
import { Severity, Soldier } from './models';

const SEV_RANK: Record<Severity, number> = { CRITICAL: 0, WARN: 1, UNKNOWN: 2, WATCH: 3, OK: 4 };

@Component({
  selector: 'app-root',
  imports: [CopMap, DecimalPipe],
  templateUrl: './app.html',
})
export class App implements OnInit {
  protected readonly c2 = inject(C2Service);
  protected readonly selected = signal<number | null>(null);

  protected readonly scenarios = [
    { id: 'injury', label: 'Injury' },
    { id: 'unconscious', label: 'Unconscious' },
    { id: 'heat', label: 'Heat strain' },
    { id: 'ambush', label: 'Ambush' },
    { id: 'hazard', label: 'Gas hazard' },
    { id: 'sos', label: 'SOS' },
    { id: 'silent', label: 'Node dark' },
  ];

  protected readonly roster = computed(() =>
    [...this.c2.soldiers()].sort(
      (a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || a.soldier_id - b.soldier_id,
    ),
  );

  protected readonly focus = computed<Soldier | null>(() => {
    const id = this.selected();
    return this.c2.soldiers().find((s) => s.soldier_id === id) ?? null;
  });

  protected readonly clock = computed(() => {
    const t = Math.floor(this.c2.state()?.mission_time_s ?? 0);
    return `T+${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  });

  ngOnInit(): void {
    this.c2.connect();
  }

  protected mmss(t: number): string {
    const s = Math.floor(t);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  protected toggle(id: number): void {
    this.selected.update((cur) => (cur === id ? null : id));
  }
}
