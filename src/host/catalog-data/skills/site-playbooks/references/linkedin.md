# LinkedIn jobs (www.linkedin.com)

Covers: recent job postings for role keywords in a place and time window.
Not covered: applying, saving jobs, profiles, people search, the personalised "recommended" feed (needs sign-in; redirects anonymous visitors to the auth wall — do not fetch `/jobs/collections/recommended/`).

For "jobs that fit my profile", build keywords from current title + top three skills + seniority.

## Guest endpoint (shell)

No cookies or headers needed; returns an HTML fragment of job cards (~25–35 KB).

```
curl -s -w '\nHTTP %{http_code}' 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=senior+frontend+engineer&location=San+Francisco+Bay+Area&f_TPR=r86400&sortBy=DD&start=0'
```

- `f_TPR`: `r3600` hour, `r86400` day, `r604800` week, `r2592000` month, omit for any time.
- `sortBy`: `DD` newest first, `R` relevance.
- `location`: free text ("New York, NY", "Remote") or `geoId` (90000084 SF Bay Area, 90000070 NYC metro, 103644278 United States, 92000000 Remote). Other ids: `https://www.linkedin.com/jobs-guest/api/typeaheadHits?query={text}&typeaheadType=GEO`. Scope follows the location, not your IP.
- Exact phrases in encoded quotes (`%22senior+react%22`) and must-have words with an encoded plus (`%2Btypescript`) are honoured.
- 10 cards per call regardless of `count`. Page with `start=10`, `20`, … and stop when fewer than 10 come back. No total is given.
- About one request per second; slower on long backfills.

## Parsing a card (`<li>`)

| Field | Where |
|---|---|
| job id | `data-entity-urn="urn:li:jobPosting:{id}"` |
| link | `a.base-card__full-link` href, cut at `?` |
| title | `h3.base-search-card__title` |
| company | link inside `h4.base-search-card__subtitle` |
| location | `span.job-search-card__location` |
| posted | `<time datetime="YYYY-MM-DD">` plus its text ("6 hours ago"); class may end in `--new` |
| order | `data-row` |
| actively hiring | "Actively Hiring" in `div.job-posting-benefits` |

Collapse whitespace. Canonical link: `https://www.linkedin.com/jobs/view/{slug}-{jobId}`. Slugs can hold percent-encoded UTF-8; dedupe on the numeric id. A 200 with no cards means the results are exhausted.

Full description of one job: `curl -s https://www.linkedin.com/jobs/view/{jobId}/` (~300 KB, has `<title>` and JSON-LD). Only for the jobs that matter, not every card.

## When the endpoint is challenged

Cloudflare sometimes answers instead (non-200, or a challenge page). Do not retry curl — switch to the browser at `https://www.linkedin.com/jobs/search?keywords=…&location=…&f_TPR=…&sortBy=DD` and read the same cards (the box browser's LinkedIn login helps if it has one). A 429 is handled the same way. A sign-in modal there is the auth wall; do not sign in yourself.
