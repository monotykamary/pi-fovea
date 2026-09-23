import Base

# One command for the next missing Chebyshev order. The host computes Float64
# vectors, but may only write the index and read the predecessors issued here.
type Step is Data:
  Empty{}
  Done{}
  First{}
  Next{at: Nat, previous: Nat, older: Nat}

def choose(allowed: Bool, +have: Nat) -> Step:
  match allowed:
    case False{}:
      Done{}
    case True{}:
      match have:
        case 0n:
          Empty{}
        case 1n+0n:
          First{}
        case 2n+p:
          Next{2n+p, 1n+p, p}

def step(+have: Nat, order: Nat) -> Step:
  match have:
    case 0n:
      Empty{}
    case 1n+p:
      choose(Nat.is_le(1n+p, order), 1n+p)
