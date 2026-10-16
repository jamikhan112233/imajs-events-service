import { Hono } from 'hono'

import type { Bindings } from './types'
import {
  addPlayersRoute,
  createCompetitionRoute,
  createRsnCodeRoute,
  enrollRoute,
  eventRoute,
  profileRoute,
  rsnChangeRoute,
  updateCompetitionRoute,
} from './routes/events'

const app = new Hono<{ Bindings: Bindings }>()

app.get('/', (c) =>
  c.json({
    service: "Imaj's Events",
    status: 'ok',
    version: '0.1.0',
  })
)

// Imaj's Events API
app.post('/api/v1/enroll', enrollRoute)
app.get('/api/v1/profile', profileRoute)
app.post('/api/v1/rsn-change', rsnChangeRoute)
app.post('/api/v1/events', eventRoute)
app.post('/api/v1/admin/competitions', createCompetitionRoute)
app.patch('/api/v1/admin/competitions/:slug', updateCompetitionRoute)
app.post('/api/v1/admin/competitions/:slug/players', addPlayersRoute)
app.post('/api/v1/admin/competitions/:slug/rsn-codes', createRsnCodeRoute)

// 404 handler
app.notFound(() => {
  return new Response('Not found', { status: 404 })
})

export default app
