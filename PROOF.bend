import Base
import ./LAWS.bend as Laws
import ./proofs/disclosure.bend as D
import ./proofs/counts.bend as C
import ./proofs/counts-proof.bend as CP
import ./proofs/heat.bend as H
import ./proofs/nat-proof.bend as N
import ./proofs/kernel.bend as K
import ./proofs/basis.bend as B

def Laws.scope_wins(excluded, seen, repeat, nucleus):
  {==}

def Laws.exclusion_wins(scope, seen, repeat, nucleus):
  match scope:
    case False{}:
      {==}
    case True{}:
      {==}

def Laws.fresh_revealed(repeat, nucleus):
  {==}

def Laws.seen_suppressed(nucleus):
  {==}

def Laws.periphery_suppressed(repeat):
  match repeat:
    case False{}:
      {==}
    case True{}:
      {==}

def Laws.nucleus_repeated(seen):
  match seen:
    case False{}:
      {==}
    case True{}:
      {==}

def Laws.shown_bounded_by_total(total, requested):
  +requested = requested
  %Equal.sym(Nat, C.fastShown(total, requested), C.shown(total, requested), CP.shown_equiv(total, requested)) : {Nat.is_le(_, total) == True{} : Bool}
  CP.bounded_total(total, requested)

def Laws.shown_bounded_by_request(total, requested):
  +total = total
  %Equal.sym(Nat, C.fastShown(total, requested), C.shown(total, requested), CP.shown_equiv(total, requested)) : {Nat.is_le(_, requested) == True{} : Bool}
  CP.bounded_request(total, requested)

def Laws.counts_conserved(total, requested):
  %Equal.sym(Nat, C.fastShown(total, requested), C.shown(total, requested), CP.shown_equiv(total, requested)) : {Nat.add(_, C.fastRemaining(total, requested)) == total : Nat}
  %Equal.sym(Nat, C.fastRemaining(total, requested), C.remaining(total, requested), CP.remaining_equiv(total, requested)) : {Nat.add(C.shown(total, requested), _) == total : Nat}
  CP.conserved(total, requested)

def Laws.full_prefix_omits_nothing(total):
  %Equal.sym(Nat, C.fastRemaining(total, total), C.remaining(total, total), CP.remaining_equiv(total, total)) : {_ == 0n : Nat}
  CP.full(total)

def Laws.cap_idempotent(total, cap):
  %Equal.sym(Nat, C.fastShown(C.fastShown(total, cap), cap), C.shown(C.fastShown(total, cap), cap), CP.shown_equiv(C.fastShown(total, cap), cap)) : {_ == C.fastShown(total, cap) : Nat}
  %Equal.sym(Nat, C.fastShown(total, cap), C.shown(total, cap), CP.shown_equiv(total, cap)) : {C.shown(_, cap) == C.fastShown(total, cap) : Nat}
  %Equal.sym(Nat, C.fastShown(total, cap), C.shown(total, cap), CP.shown_equiv(total, cap)) : {C.shown(C.shown(total, cap), cap) == _ : Nat}
  CP.idempotent(total, cap)

def Laws.heat_vector_add_mass(xs, ys):
  match xs ys:
    case Nil{} _:
      {==}
    case x <> tail Nil{}:
      Equal.sym(Nat, Nat.add(H.sum(x <> tail), 0n), H.sum(x <> tail), N.add_zero(H.sum(x <> tail)))
    case x <> xt y <> yt:
      %N.add_shuffle(x, y, H.sum(xt), H.sum(yt)) : {Nat.add(Nat.add(x, y), H.sum(H.add(xt, yt))) == _ : Nat}
      %Laws.heat_vector_add_mass(xt, yt) : {Nat.add(Nat.add(x, y), H.sum(H.add(xt, yt))) == Nat.add(Nat.add(x, y), _) : Nat}
      {==}

def Laws.heat_scale_mass(mass, weights):
  match mass:
    case 0n:
      {==}
    case 1n+p:
      %Laws.heat_scale_mass(p, weights) : {H.sum(H.add(weights, H.scale(p, weights))) == Nat.add(H.sum(weights), _) : Nat}
      Laws.heat_vector_add_mass(weights, H.scale(p, weights))

def Laws.heat_transport_mass(columns, denominator, normalized):
  match columns:
    case Nil{}:
      {==}
    case H.Source{mass, weights} <> tail:
      (column_norm, tail_norm) = normalized
      %N.mul_add(mass, H.input_mass(tail), 1n+denominator) : {H.sum(H.add(H.scale(mass, weights), H.transport(tail))) == _ : Nat}
      %Equal.cong(Nat, Nat, x => Nat.mul(mass, x), H.sum(weights), 1n+denominator, column_norm) : {H.sum(H.add(H.scale(mass, weights), H.transport(tail))) == Nat.add(_, Nat.mul(H.input_mass(tail), 1n+denominator)) : Nat}
      %Laws.heat_scale_mass(mass, weights) : {H.sum(H.add(H.scale(mass, weights), H.transport(tail))) == Nat.add(_, Nat.mul(H.input_mass(tail), 1n+denominator)) : Nat}
      %Laws.heat_transport_mass(tail, denominator, tail_norm) : {H.sum(H.add(H.scale(mass, weights), H.transport(tail))) == Nat.add(H.sum(H.scale(mass, weights)), _) : Nat}
      Laws.heat_vector_add_mass(H.scale(mass, weights), H.transport(tail))

def Laws.heat_singleton_mass(mass):
  %N.mul_one(mass) : {H.sum(H.transport([H.Source{mass, [1n]}])) == _ : Nat}
  %N.add_zero(mass) : {H.sum(H.transport([H.Source{mass, [1n]}])) == Nat.mul(_, 1n) : Nat}
  Laws.heat_transport_mass([H.Source{mass, [1n]}], 0n, ({==}, Unit{}))

def Laws.basis_empty_refused(order):
  {==}

def Laws.basis_complete_retained(have, order, complete):
  %Equal.sym(Bool, Nat.is_le(1n+have, order), False{}, complete) : {B.choose(_, 1n+have) == B.Done{} : B.Step}
  {==}

def Laws.basis_first_order(order):
  match order:
    case 0n:
      {==}
    case 1n+p:
      {==}

def Laws.basis_next_exact(have, order, missing):
  %Equal.sym(Bool, Nat.is_le(2n+have, order), True{}, missing) : {B.choose(_, 2n+have) == B.Next{2n+have, 1n+have, have} : B.Step}
  {==}
