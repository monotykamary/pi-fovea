import Base
import ./proofs/disclosure.bend as D
import ./proofs/heat.bend as H
import ./proofs/kernel.bend as K
import ./proofs/basis.bend as B

# Proposed specifications extracted from render.ts and heat.ts. Review these independently
# of PROOF.bend; do not weaken a law to make an implementation pass.

# Disclosure: these six laws cover the entire five-Boolean input domain.
law scope_wins:
  for excluded: Bool
  for seen: Bool
  for repeat: Bool
  for nucleus: Bool
  {K.disclosure(False{}, excluded, seen, repeat, nucleus) == D.Drop{} : D.Decision}

law exclusion_wins:
  for scope: Bool
  for seen: Bool
  for repeat: Bool
  for nucleus: Bool
  {K.disclosure(scope, True{}, seen, repeat, nucleus) == D.Drop{} : D.Decision}

law fresh_revealed:
  for repeat: Bool
  for nucleus: Bool
  {K.disclosure(True{}, False{}, False{}, repeat, nucleus) == D.Reveal{} : D.Decision}

law seen_suppressed:
  for nucleus: Bool
  {K.disclosure(True{}, False{}, True{}, False{}, nucleus) == D.Suppress{} : D.Decision}

law periphery_suppressed:
  for repeat: Bool
  {K.disclosure(True{}, False{}, True{}, repeat, False{}) == D.Suppress{} : D.Decision}

law nucleus_repeated:
  for seen: Bool
  {K.disclosure(True{}, False{}, seen, True{}, True{}) == D.Reveal{} : D.Decision}

# Executed natural-number accounting. This does NOT prove token estimation,
# renderer formatting, or binary-search monotonicity. Keep boundary tests.
law shown_bounded_by_total:
  for +total: Nat
  for requested: Nat
  {Nat.is_le(K.shownCount(total, requested), total) == True{} : Bool}

law shown_bounded_by_request:
  for total: Nat
  for +requested: Nat
  {Nat.is_le(K.shownCount(total, requested), requested) == True{} : Bool}

law counts_conserved:
  for +total: Nat
  for +requested: Nat
  {Nat.add(K.shownCount(total, requested), K.remainingCount(total, requested)) == total : Nat}

law full_prefix_omits_nothing:
  for +total: Nat
  {K.remainingCount(total, total) == 0n : Nat}

law cap_idempotent:
  for +total: Nat
  for +cap: Nat
  {K.shownCount(K.shownCount(total, cap), cap) == K.shownCount(total, cap) : Nat}

# Exact nonnegative rational transport model, not IEEE-754 or the exponential.
law heat_vector_add_mass:
  for +xs: +List<Nat>
  for +ys: +List<Nat>
  {H.sum(H.add(xs, ys)) == Nat.add(H.sum(xs), H.sum(ys)) : Nat}

law heat_scale_mass:
  for +mass: Nat
  for +weights: +List<Nat>
  {H.sum(H.scale(mass, weights)) == Nat.mul(mass, H.sum(weights)) : Nat}

# D = 1 + denominator is strictly positive. For source numerators a over Q,
# transport returns numerators over D*Q; this equality conserves rational mass.
law heat_transport_mass:
  for +columns: +List<H.Column>
  for +denominator: Nat
  for normalized: H.Normalized(columns, 1n+denominator)
  {H.sum(H.transport(columns)) == Nat.mul(H.input_mass(columns), 1n+denominator) : Nat}

law heat_singleton_mass:
  for +mass: Nat
  {H.sum(H.transport([H.Source{mass, [1n]}])) == mass : Nat}

# Executed basis-extension commands. Float64 evaluation remains host code.
law basis_empty_refused:
  for order: Nat
  {K.basisStep(0n, order) == B.Empty{} : B.Step}

law basis_complete_retained:
  for +have: Nat
  for +order: Nat
  for complete: {Nat.is_le(1n+have, order) == False{} : Bool}
  {K.basisStep(1n+have, order) == B.Done{} : B.Step}

law basis_first_order:
  for order: Nat
  {K.basisStep(1n, 1n+order) == B.First{} : B.Step}

law basis_next_exact:
  for +have: Nat
  for +order: Nat
  for missing: {Nat.is_le(2n+have, order) == True{} : Bool}
  {K.basisStep(2n+have, order) == B.Next{2n+have, 1n+have, have} : B.Step}
