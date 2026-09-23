import Base
import ./counts.bend as C

def choose_lift(+ok: Bool, +a: Nat, +b: Nat) -> {C.choose(ok, 1n+a, 1n+b) == 1n+C.choose(ok, a, b) : Nat}:
  match ok:
    case True{}:
      {==}
    case False{}:
      {==}

def shown_equiv(+total: Nat, +requested: Nat) -> {C.fastShown(total, requested) == C.shown(total, requested) : Nat}:
  match total requested:
    case 0n 0n:
      {==}
    case 0n 1n+r:
      {==}
    case 1n+t 0n:
      {==}
    case 1n+t 1n+r:
      %shown_equiv(t, r) : {C.choose(Nat.is_le(t, r), 1n+t, 1n+r) == 1n+_ : Nat}
      choose_lift(Nat.is_le(t, r), t, r)

def remaining_equiv(+total: Nat, +requested: Nat) -> {C.fastRemaining(total, requested) == C.remaining(total, requested) : Nat}:
  Equal.cong(Nat, Nat, x => Nat.sub(total, x), C.fastShown(total, requested), C.shown(total, requested), shown_equiv(total, requested))

def bounded_total(+total: Nat, requested: Nat) -> {Nat.is_le(C.shown(total, requested), total) == True{} : Bool}:
  match total requested:
    case 0n _:
      {==}
    case 1n+t 0n:
      {==}
    case 1n+t 1n+r:
      bounded_total(t, r)

def bounded_request(total: Nat, +requested: Nat) -> {Nat.is_le(C.shown(total, requested), requested) == True{} : Bool}:
  match total requested:
    case 0n 0n:
      {==}
    case 0n 1n+r:
      {==}
    case 1n+t 0n:
      {==}
    case 1n+t 1n+r:
      bounded_request(t, r)

def conserved(+total: Nat, +requested: Nat) -> {Nat.add(C.shown(total, requested), C.remaining(total, requested)) == total : Nat}:
  match total requested:
    case 0n _:
      {==}
    case 1n+t 0n:
      {==}
    case 1n+t 1n+r:
      %conserved(t, r) : {1n+Nat.add(C.shown(t, r), C.remaining(t, r)) == 1n+_ : Nat}
      {==}

def full(+total: Nat) -> {C.remaining(total, total) == 0n : Nat}:
  match total:
    case 0n:
      {==}
    case 1n+t:
      full(t)

def idempotent(+total: Nat, +cap: Nat) -> {C.shown(C.shown(total, cap), cap) == C.shown(total, cap) : Nat}:
  match total cap:
    case 0n _:
      {==}
    case 1n+t 0n:
      {==}
    case 1n+t 1n+c:
      %idempotent(t, c) : {1n+C.shown(C.shown(t, c), c) == 1n+_ : Nat}
      {==}
