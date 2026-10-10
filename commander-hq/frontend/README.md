# Frontend

Angular 21 map display (COP) for the commander. It connects to the backend WebSocket `/ws`: same origin when the backend serves it, port 8000 when run with `ng serve`.

```bash
npm install
npx ng serve     # dev server with reload: http://localhost:4200
npx ng build     # output in dist/; the backend then serves it at http://localhost:8000
npx ng test      # unit tests (Vitest)
```

Requires Node 20.19+ or 22.12+. Start the backend first; see [../README.md](../README.md).
