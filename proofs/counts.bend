import Base

# Executed prefix accounting, exported through kernel.bend. The adapter admits
# only bounded natural counts; string/token formatting stays outside the proof.
def shown(total: Nat, requested: Nat) -> Nat:
  Nat.min(total, requested)

def remaining(+total: Nat, requested: Nat) -> Nat:
  Nat.sub(total, shown(total, requested))

# Constant-time backend path. counts-proof.bend proves it equals the structural
# specification above; do not substitute handwritten JS for Nat.min.
def choose(allowed: Bool, total: Nat, requested: Nat) -> Nat:
  match allowed:
    case True{}:
      total
    case False{}:
      requested

def fastShown(+total: Nat, +requested: Nat) -> Nat:
  choose(Nat.is_le(total, requested), total, requested)

def fastRemaining(+total: Nat, requested: Nat) -> Nat:
  Nat.sub(total, fastShown(total, requested))
