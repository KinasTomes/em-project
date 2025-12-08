| Feature            | Order | Payment | Inventory        | Product        | Auth |
|--------------------|-------|---------|------------------|----------------|------|
| Clean Architecture | ✅     | ✅       | ✅                | ⚠️              | ⚠️    |
| Async start()      | ✅     | ✅       | ✅                | ✅ (vừa fix)    | ❌    |
| Graceful Shutdown  | ✅     | ✅       | ✅                | ✅ (vừa fix)    | ❌    |
| Health Check       | ✅     | ✅       | ✅                | ✅ (vừa fix)    | ❌    |
| Outbox Pattern     | ✅     | ✅       | ✅                | ❌              | ❌    |
| Idempotency        | ✅     | ✅       | ✅                | ❌              | ❌    |
| Schema Validation  | ✅     | ✅       | ✅                | ❌              | ❌    |
| Circuit Breaker    | ✅     | ❌       | ❌                | ❌              | ❌    |
| State Machine      | ✅     | ❌       | ❌                | ❌              | ❌    |
| Distributed Lock   | ❌     | ❌       | ✅ (vừa thêm)     | ❌              | ❌    |
| Audit Log          | ❌     | ❌       | ✅ (vừa thêm)     | ❌              | ❌    |
| Retry + Backoff    | ❌     | ✅ (vừa thêm) | ❌          | ❌              | ❌    |
