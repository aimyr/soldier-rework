import { Component, computed, input, output } from '@angular/core';
import { Soldier, SquadEvent } from './models';

const CP = { x: 150, y: 15 };

@Component({
  selector: 'app-cop-map',
  template: `
    <svg [attr.viewBox]="'-12 -12 ' + (size() + 24) + ' ' + (size() + 24)" class="cop-svg" role="img"
         aria-label="Common Operational Picture">
      <defs>
        <pattern id="minor" width="20" height="20" patternUnits="userSpaceOnUse">
          <path d="M20 0H0V20" fill="none" class="grid-minor" />
        </pattern>
      </defs>
      <rect x="0" y="0" [attr.width]="size()" [attr.height]="size()" fill="url(#minor)" class="ao" />

      @for (c of cells(); track c.name) {
        <rect [attr.x]="c.x" [attr.y]="c.y" [attr.width]="cell()" [attr.height]="cell()"
              class="sector" [class.sector-contact]="c.contact" [class.sector-hazard]="c.hazard" />
        <text [attr.x]="c.x + 6" [attr.y]="c.y + 14" class="sector-label">{{ c.name }}</text>
        @if (c.contact) {
          <text [attr.x]="c.x + 6" [attr.y]="c.y + cell() - 8" class="sector-tag tag-contact">POSSIBLE CONTACT</text>
        }
        @if (c.hazard) {
          <text [attr.x]="c.x + 6" [attr.y]="c.y + cell() - (c.contact ? 18 : 8)" class="sector-tag tag-hazard">HAZARD AREA</text>
        }
      }

      @for (s of placed(); track s.soldier_id) {
        <polyline [attr.points]="s.trail" class="trail" [attr.data-sev]="s.severity" />
      }

      <g [attr.transform]="'translate(' + cp.x + ',' + (size() - cp.y) + ')'">
        <rect x="-7" y="-7" width="14" height="14" class="cp" />
        <text y="20" text-anchor="middle" class="cp-label">CP</text>
      </g>

      @for (s of placed(); track s.soldier_id) {
        <g class="unit" [attr.data-sev]="s.severity" [class.selected]="s.soldier_id === selected()"
           [attr.transform]="'translate(' + s.px + ',' + s.py + ')'" (click)="pick.emit(s.soldier_id)">
          @if (s.severity === 'CRITICAL') {
            <circle r="10" class="pulse" />
          }
          <circle r="4.5" class="dot" />
          <text y="-7" text-anchor="middle" class="unit-label">{{ s.callsign }}</text>
        </g>
      }
    </svg>
  `,
})
export class CopMap {
  readonly soldiers = input<Soldier[]>([]);
  readonly events = input<SquadEvent[]>([]);
  readonly missionTime = input(0);
  readonly size = input(300);
  readonly n = input(3);
  readonly selected = input<number | null>(null);
  readonly pick = output<number>();

  protected readonly cp = CP;
  protected readonly cell = computed(() => this.size() / this.n());

  protected readonly cells = computed(() => {
    const n = this.n(), c = this.cell(), size = this.size(), now = this.missionTime();
    const recent = this.events().filter((e) => now - e.t_s <= 120);
    const out = [];
    for (let col = 0; col < n; col++) {
      for (let row = 0; row < n; row++) {
        const name = `${String.fromCharCode(65 + col)}${row + 1}`;
        out.push({
          name, x: col * c, y: size - (row + 1) * c,
          contact: recent.some((e) => e.sector === name && e.kind === 'POSSIBLE_CONTACT'),
          hazard: recent.some((e) => e.sector === name && e.kind === 'HAZARD_AREA'),
        });
      }
    }
    return out;
  });

  protected readonly placed = computed(() => {
    const size = this.size();
    const clamp = (v: number) => Math.max(0, Math.min(size, v));
    return this.soldiers()
      .filter((s) => s.x_m !== null && s.y_m !== null)
      .map((s) => ({
        ...s,
        px: clamp(s.x_m!),
        py: size - clamp(s.y_m!),
        trail: s.trail.map(([x, y]) => `${clamp(x)},${size - clamp(y)}`).join(' '),
      }));
  });
}
