# Heat diffusion and the design behind it

Heat diffusion starts from one typed undirected graph. A kernel spreads over it, and a renderer shows the result in tiers. A statistical layer finds routes in workspaces you have not seen before. Code references point to `src/core/`.

## The graph

The repo compiles into one typed undirected graph $G = (V, E)$. Nodes are files, symbols, and anchors. Every edge carries a conductance $W_{ij} > 0$. Edge kinds and weights:

| Edge kind | Weight |
|---|:--:|
| `contains` file → symbol | $1$ |
| `inherits` class → parent | $0.9$ |
| `tests` test file → subject | $0.6$ |
| `invokes` caller → callee | see below |
| `imports` file → file | $0.3$ |
| `anchors` anchor hub → handler | $c / \sqrt{S}$ |
| `anchors` hub → member file | $0.35 / \sqrt{\|F\|}$ |
| `join` literal bridge | see below |

Call edges are specificity-tiered, so a call to a rare symbol beats one to a common symbol. Builtins and log or test entry points are warded off. A `console.log` call connects nothing. The anchor hub weight decays with the number of sites $S$ bound to it, so a multi-site route never becomes a gravity well. File-member weights decay with $|F|$, the file count of the feature hood.

Anchor labels are normalized so one route shows up once. Every placeholder syntax, such as `{id}`, `:id`, `${id}`, or `$code`, becomes `{*}` before hub assignment. Ktor's `${code}` shorthand and the Rails `:id` form land in one cluster.

## The heat kernel

Build the symmetric normalized Laplacian

$$
L = I - D^{-1/2} W D^{-1/2}
$$

where $W$ is the max-conductance adjacency and $D$ the diagonal degree matrix with $D_{ii} = \sum_j W_{ij}$. The spectrum of $L$ sits in $[0,2]$. For an interest vector $s \in \mathbb{R}^{|V|}$ and a diffusion time $t$:

$$
v(t) = e^{-tL} \cdot s
$$

Heat in $v(t)$ tells you what sits near $s$ along low-resistance paths. With small $t$, heat stays near the seeds. Large $t$ lets it follow the whole skeleton.

Evaluation uses a Chebyshev expansion. Put $M = L - I$ so the eigenvalues live in $[-1,1]$, and let $T_k$ be the Chebyshev polynomials. Then

$$
e^{-tL} = e^{-t} \left[ I_0(t) T_0(M) + 2 \sum_{k=1}^{\infty} (-1)^k I_k(t) T_k(M) \right]
$$

with $I_k$ the modified Bessel function. The vectors $T_k(M) s$ follow the recurrence

$$
T_0(M)s = s, \qquad T_k(M)s = 2 M \left(T_{k-1}(M)s\right) - T_{k-2}(M)s \quad (k \ge 2)
$$

and are cached per session. A new timescale recombines coefficients for $O(K \cdot n)$ work, so no second walk runs. The order $K$ grows with $\lceil 2.2 t \rceil + 16$ and tops out at 90. Measured error against a scaling-and-squaring Taylor reference lands at $\sim 6 \times 10^{-9}$.

No Jackson damping window is applied. The SGWT wavelet frame applies windows because its compactly supported bumps ring at the support edge. $e^{-t(1+\mu)}$ is smooth on $[-1,1]$ and truncation decays superalgebraically, so a Jackson window here would only cut pointwise accuracy. `src/core/heat.ts` carries the check.

## The four tools

All four tools call the same kernel with different seeds at different timescales:

| Tool | Seeds | $t$ |
|---|---|:--:|
| sketch | production anchors ∪ production regions (cap 64) | $16$ |
| focus | resolved symbols / literal sites | $2$ |
| dwell | same source re-seeded | $\times 2$ each call |
| impact | changed files | $4$ |

The renderer reads $v(t)$ and normalizes by $v_{\max}$. A node above $0.3 v_{\max}$ prints its signature. Between $0.02$ and $0.3 v_{\max}$ it becomes a one-liner, and everything lower collapses into per-file counts. Typed one-hop neighbors lead the anonymous thermal periphery. Unrelated warm nodes are capped per file, while sketch demotes test and fixture scopes in presentation only. The graph and heat field stay unchanged. A binary search over the fixed candidate order still yields a monotonic prefix, and that prefix never exceeds the token budget.

Disclosure is scoped to the current seed set. Repeated focus keeps the seed and direct nucleus visible while suppressing what you have seen. Dwell returns newly relevant neighbors. Changing focus resets to $t=2$ and clears the disclosure scope. `fresh` does the same explicitly for reproducibility.

## Literal bridges

Coupling appears wherever a string literal repeats across files, such as a route path, an env name, or a long identifier. Each literal class carries a base weight

$$
B = \begin{cases} 1.0 & \text{path} \\ 0.8 & \text{env} \\ 0.55 & \text{word} \end{cases}
$$

A literal occurring in $\mathrm{df}$ files earns specificity

$$
\mathrm{spec} = \min \left( 1, \frac{\log \left(\mathrm{total} / \max(\mathrm{df}, 1)\right)}{\max_{\ell'} \log \left(\mathrm{total} / \mathrm{df}_{\ell'}\right)} \right)
$$

Bridge edges form a clique over the files that carry that literal. The clique only builds when $2 \le \mathrm{df} \le 48$. Inside the band each edge weighs

$$
w = \frac{B \cdot (0.25 + 0.75 \cdot \mathrm{spec})}{\max(1, \mathrm{df} / 6)}
$$

The denominator stops a popular literal from turning into an uncapped hub. Repetition inside one file cannot inflate $\mathrm{df}$, or a lockfile would dominate every bridge.

## Co-change history enters as heat

Joint git history carries the *software development over time* signal. The affinity diffusion cannot see that signal by construction. Files $a$ and $b$ that keep moving together in the same commits share a bond the parser never encodes. Under the all-in heat model that bond is a **seeded field**. It never becomes a permanent graph edge.

- `cochange.ts` mines the last 400 commits and records each pair's joint-commit count plus the committer time of its **most recent** joint commit. Those raw facts get cached by HEAD and tracked-file set. The static graph carries **no** co-change edge, so focus and sketch read the operator and stay pure structure.
- When `impact` seeds a change, it re-seeds the change site's history partners into the *same* diffusion at $w = w_0(\text{count}, \text{jaccard}) \cdot 2^{-\text{ageDays} / \tau}$ with a half-life of $\tau = 30 \text{ days}$, where $w_0$ is the old Jaccard-tilted base conductance and age runs on wall clock since the pair last co-committed, $(\text{age} = \max(0, \text{now} - \text{lastTs}))$.
- Linearity is what makes this heat. Seeding partner files at weight $w$ and diffusing once gives $e^{-tL}(s_{\text{change}} + w \, s_{\text{partner}})$. Fresh joint work stays hot. A pair that last moved months ago contributes almost nothing, and an idle session cools the affinity like any other heat source. Even a cached hit cools, because recency applies at **use** time. Nothing about recency lives in the cache.
- Partner files surface with the `co-change history` reason. Turn sync still weighs them at $c_v = 0.5$. The per-node sync ledger $\mu$ governs how often that channel can refire (see Turn sync below).

`FOVEA_COCHANGE_HALF_LIFE_DAYS` (default 30) sets the wall-clock half-life.

## Conserved fields: the degree-corrected view

The raw field $v(t) = e^{-tL}s$ answers *what is near what*, but on the symmetric normalized Laplacian it is not mass-conserving: the $D^{-1/2}$ coordinates carry a $\sqrt{d}$ bias, and $\sum_i v_i(t)$ drifts with graph size and component structure. Heat retained by a hub and heat retained by a leaf are not comparable, and thresholds calibrated on one repo do not transfer to another.

`heat.ts` therefore exposes the random-walk view on the same Chebyshev machinery:

- `forwardHeat(csr, a, t)`: seed mass vector $a$ (one unit per changed node) in, $v = e^{-tL}(D^{-1/2}a)$, out $p = D^{1/2}v$. This is forward random-walk heat: $\sum_{i \in C} p_i$ is **conserved within each connected component** for all $t$, and the stationary limit is degree-proportional, $p_i \propto d_i$. Isolated nodes (own component, $L_{ii}=1$) retain their seed mass.
- `focusField(csr, a, t)` and `excess(f, deg)`: the focus-side transform $f = D^{-1/2} e^{-tL} D^{1/2} a$, with positive excess scored above the component's degree-weighted stationary mean, so ranking asks *warmer than equilibrium?* instead of *how warm?*

`impact` emits per-file conserved mass as `conservedMass` next to `warmedMass` — a parallel measurement, seeds excluded. Sync gates stay on the calibrated raw scale until thresholds are re-derived on the conserved one; the two are never mixed.

## Obligations: the conservative half

Heat answers *what is interesting now*, and its dissipation is a feature: a prior that never forgets saturates into uniform warmth and stops guiding. But completeness is a different invariant. A session that renders, discloses, or wall-clock-decays its way past unfinished work has not finished the work — it has lost the ledger. So the same graph supports a second field with the opposite physics:

- **Additive, never decaying.** Every `impact` cascade merges its per-file residual mass into the session's obligation epoch (`mergeWarmed` with the `diffusion residual` reason). Entries persist through disclosure, rendering, and wall-clock time. Mass leaves the `unresolved` state only through named evidence transitions: a successful read after the entry's generation marks it `inspected`, a semantic edit marks it `changed` (bumping the generation so later reads can re-mark), verification marks it `verified`. Nothing is deleted by anything else.
- **Bounded, deterministically.** The ledger caps at 512 files, evicting the weakest mass first with path-order tie-breaks. Resets happen only at an explicit epoch reset or `resetSessions()`.
- **Surfaced in `impact` details** as `obligations` (strongest unresolved first, with reasons and generations) and `epoch` totals — a checklist the environment keeps so a model cannot confuse *having seen* with *having finished*.
- **Host wiring.** The status transitions (`markRead`, `markEdited`, `markVerified`) are exported for the host's tool-end hooks; until those land, entries accumulate as `unresolved`, which is the safe default — an unproven obligation stays one.

The design split, stated once: **heat is dissipative because attention must rank; obligations are conservative because completeness is conservation** — mass leaves the ledger only through evidence, like double-entry accounting rather than the heat equation. The two fields are dual, not redundant.

## Unmet-companion residuals: heat for absence

Co-change history says what *usually* moves together; a latent-coupling bug is what *should have* moved and didn't. That is counterfactual — no diffusion can warm a file for not changing. So the residual is computed directly from the directional history and seeded as labelled heat:

- The co-change cache (v3) now retains directional counts: $n_{ij}$ joint commits, $n_i$, $n_j$ total commits per file within the scanned window.
- For changed file $i$ and unchanged partner $j$, the conditional $q(j \mid i)$ is taken as the **Wilson score lower bound** (95%) on $n_{ij}/n_i$, discounted by lift (the conditional must beat the base rate $n_j/N$ by a margin), a support floor ($n_{ij} \ge 3$), and the same $2^{-\text{ageDays}/\tau}$ recency as pair conductance. Weight is capped at 1.
- $r_j = (1 - x_j)\bigl[1 - \prod_{i : x_i = 1}(1 - q(j|i))\bigr]$ over the changed set — the probability that at least one changed file's expected companion failed to appear. Deterministic: fixed iteration order, weight desc then path.

Residuals surface in `impact` details as `expectedButUnchanged` (strongest first, capped at 12) and merge into the obligation ledger under `unmet co-change companion`. They cool as history ages and vanish the moment the companion joins the diff — evidence, not assertion.

## Inferred regions (basins)

Where a repo has no anchors, the silhouette uses inferred features instead. Seeds are nodes whose conductance and local triangle density $\tau$ pass thresholds. A seed scores

$$
\mathrm{score}(i) = c_i \left(0.25 + 0.75 \tau_i\right) + 0.02 \deg_i
$$

with $c_i$ the conductance. Regions grow by greedily absorbing the boundary node with the highest ratio

$$
\frac{\sum_{j \text{ in basin}} W_{ij}}{\sum_{j \in V} W_{ij}}
$$

of its incident weight, with a cut-domination stop rule. The result is a handful of cohesive clusters, capped at $12$ regions of up to $64$ nodes. Production anchors outrank inferred regions when both exist. Test and fixture anchors stay in the graph but collapse in the opening sketch.

## Discovery mode

Unknown route DSLs are the main coverage gap in a static pack. Discovery repairs that gap with the moves below.

**Harvest.** During the literal pass, every call site contributes a signature $(\mathrm{lang}, \mathrm{shape}, \mathrm{callee}, \mathrm{argIdx})$. The shape is one of receiver-less, method-call, decorator, or bare-call. $\mathrm{argIdx}$ holds the zero-based position of the first string literal argument. Because harvesting runs inside the same pass, scanning a file once is enough.

**Promotion.** For each signature we estimate how often argument $\mathrm{argIdx}$ carries a route path. The Jeffreys posterior over the binomial rate is

$$
\hat{p} = \frac{\mathrm{pathN} + \frac{1}{2}}{\mathrm{n} + 1}
$$

and a shape promotes into a synthesized ast-grep rule when $\hat{p} \ge 0.55$, $\mathrm{n} \ge 4$, and its sites cover at least two files. The pack-coverage filter blocks shapes the static pack already knows. In nine cloned projects, corpus junk sat below $\hat{p} \approx 0.27$. Real route shapes came in above $\hat{p} \approx 0.75$. The line sits mid-cliff between them, regardless of repo size.

**Half gravity.** Promoted rules become implicit hubs. Their anchor edges sit at

$$
w = \frac{0.5}{\sqrt{S}}
$$

Declared routes weigh $1/\sqrt{S}$, where $S$ is the number of sites bound to the hub. Swap rates are symmetric constants that do not depend on the corpus. Turn sync reports churn on discovered hubs, a `△` in the anchors report, with no red escalation. As soon as any site matches a first-class rule, the hub graduates.

## Turn sync shows only surprise

The impact cascade that answers `fovea_impact` also feeds turn sync. Turn sync runs before agent start and after every assistant turn, then decides whether drift justifies spending model tokens. The code lives in `src/core/sync.ts`. The verdict belongs to each graph node. Every node $v$ warmed above $10^{-6}$ carries a field mass $m_v$ plus the first-encounter channel reasons of its warm path. That path is 1-hop edge kinds, BFS paths for deeper nodes, or a `co-change history` stamp for history-seeded clusters. Warmth aggregation by file exists only for display. The memory and surprise arithmetic run at node granularity.

Each sync keeps a ledger $\mu$ of charged node masses, keyed by stable node identity `kind|name@file`. The key is hunk-level, so line moves stay free and renames simply orphan entries. The evidence channel enters as a prior $c_v$, the strongest reason on that node's path:

| Channel | $c_v$ |
|---|:--:|
| call / import / test / inheritance / shared route | $1$ |
| co-change history | $0.5$ |
| multi-hop graph path | $0.5$ |
| shared literal | $0.35$ |

Surprise is the channel-adjusted mass above the ledger, summed over nodes and grouped back to files for the message:

$$
s_v = \max\!(0,\; c_v \, m_v - \mu_v), \qquad S = \textstyle\sum_v s_v
$$

A sync goes red on structural events or when warmth alone crosses the steer threshold $S \ge \theta$, with $\theta = 0.15$ by default (`sync.steerThreshold`). Structural events mean a route added or removed **with carrier-file drift evidence**, or a production file deleted. Both respect the degraded-extraction distrust. Masses are dimensionless. Seeding is one heat unit per changed file node, so $S$ reads as "units of evidence-weighted heat landing outside the change that were not already disclosed." Calibration on `tests/fixtures/mini` gives a feel for the scale. A central semantic edit totals $\approx 0.115$ node-adjusted. One strong call/import neighbor on a 350-node repo comes to $\approx 0.19$. The weakest case, a pair of weak literal or co-change warm-ups, lands at $\approx 0.01\!-\!0.03$.

Four dynamics fall out of $\mu$:

- **Absorb on disclosure.** Any red sync charges $\mu_v \leftarrow \max(\mu_v, c_v m_v)$ for every warmed node, displayed or not. Re-editing the same spot re-seeds the same node keys, all charged, and in-session decay stays negligible. Flip-flopped work stays silent on every revisit, indefinitely. The disclosed cascade is *structurally unable to re-fire*.
- **Wall-clock decay.** Entries age as $\mu_v \leftarrow \mu_v \cdot 2^{-\Delta t / \tau_h}$ with $\tau_h = 48\,\mathrm{h}$ (`FOVEA_MEMORY_HALF_LIFE_HOURS`). The decay ticks on wall clock, whatever the sync count. A structurally re-heated neighborhood can earn a fresh verdict on a later day. Renamed-symbol orphans cool out on the same schedule. The ledger is bounded at 4096 nodes with weakest-mass eviction, and the impact payload tail-caps at 2000 nodes.
- **No blanket.** Charged keys suppress only themselves. A novel hunk in a charged cluster, say a fresh literal or a stronger coupling, keeps its own surprise and can cross $\theta$ even while the rest stays damped. Quiet verdicts charge nothing, so a trickle of sub-threshold warmth cannot habituate the gate.
- **Hysteresis.** A fire disarms the warmth latch. It re-arms only once $S \le \theta/2$. Cascades hovering near the threshold cannot oscillate.

Anchor deltas obey carrier evidence. A route add or remove escalates and renders only when its carrier file drifted. Content-identical carriers keep content-identical anchors by construction. Carrier-less deltas are extraction artifacts, such as parallel-load sweeps or extractor-version re-derivation, and stay quiet. They show as `suspectAnchors` in details while the baseline adopts the new set immediately, and the artifact self-heals. Deletions and route changes with real carrier drift bypass the warmth gate entirely.

The rendered list sorts by surprise descending, with test scopes last within a tie. The top of the message is always the least-expected warmth. A clean structural turn costs one fingerprint diff, and a quiet turn costs the same, because the gate only evaluates when the version fingerprint moved. Switching branches re-baselines silently. A `git checkout` re-materializes the worktree without authored drift. The baseline follows the ref, and the ledger does not cross over.
