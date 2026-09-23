import Base
import ./disclosure.bend as D
import ./counts.bend as C
import ./basis.bend as B

# These exact exports are named by LAWS.bend and consumed by production.
def disclosure(scope: Bool, excluded: Bool, seen: Bool, repeat: Bool, nucleus: Bool) -> D.Decision:
  D.disclosure(scope, excluded, seen, repeat, nucleus)

def shownCount(total: Nat, requested: Nat) -> Nat:
  C.fastShown(total, requested)

def remainingCount(total: Nat, requested: Nat) -> Nat:
  C.fastRemaining(total, requested)

def basisStep(have: Nat, order: Nat) -> B.Step:
  B.step(have, order)

type Kernel is Type:
  Kernel{disclosure: Bool -> Bool -> Bool -> Bool -> Bool -> D.Decision, shown: Nat -> Nat -> Nat, remaining: Nat -> Nat -> Nat, basis: Nat -> Nat -> B.Step}

# Pure bootstrap to retain exported definitions during compilation. The bridge
# removes the pinned CLI invocations; neither this IO value nor an effect runs.
def main() -> IO(Kernel):
  IO.pure(Kernel, Kernel{disclosure, shownCount, remainingCount, basisStep})
