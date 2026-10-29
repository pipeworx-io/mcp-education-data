# mcp-education-data

Education Data MCP — US K-12 schools, districts, funding and child poverty.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1856+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

| Tool | Description |
|------|-------------|
| `education_find_schools` | Find US K-12 PUBLIC SCHOOLS by state, with optional city or name filter. Keyless federal data (NCES Common Core of Data via the Urban Institute). Returns each school's NCES id, name, district, city, enrollment, charter/magnet status, grade range, and free/reduced-price lunch counts. Use for "public schools in <city/state>", "how many students at <school>", "charter schools in <state>", "which schools have the highest enrollment". For school DISTRICTS use education_find_districts; for COLLEGES use the college-scorecard pack instead — this covers K-12 only. |
| `education_find_districts` | Find US PUBLIC SCHOOL DISTRICTS (local education agencies) by state, with optional name filter. Keyless federal data (NCES Common Core of Data). Returns each district's LEA id, name, county, city, number of schools, enrollment, and teacher counts. Use for "school districts in <state>", "how big is <district>", "how many students does <district> serve". The returned leaid feeds education_district_finance and education_child_poverty. |
| `education_district_finance` | School district FUNDING AND SPENDING — revenue by source (federal / state / local) and expenditure by function, plus computed PER-PUPIL spending. Keyless federal data (NCES CCD school district finance survey, F-33). Use for "how much does <district> spend per student", "school funding by district in <state>", "which districts get the most federal money", "local vs state share of school funding". Pass a state to rank districts, or a leaid (from education_find_districts) for one district. Note the finance survey lags the directory data by 1-2 years. |
| `education_child_poverty` | CHILD POVERTY by school district — Census SAIPE estimates of the number and percentage of school-age children (5-17) in poverty, which drive federal Title I funding. Keyless. Use for "child poverty rate in <district>", "poorest school districts in <state>", "how many students in poverty in <district>". Pass a state to rank districts by poverty rate, or a leaid for one district. |

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "education-data": {
      "url": "https://gateway.pipeworx.io/education-data/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/education-data/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1856+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/education_find_schools \
  -H 'Content-Type: application/json' \
  -d '{"state":"TX","city":"Austin"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/education_find_schools`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-education-data` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/education-data/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "education-data": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-education-data"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Education Data data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
