import Base

# Exact numerator model of a column-stochastic random-walk step, NOT the
# Float64/Chebyshev runtime. Vectors are zero-padded; [] represents zero.
def sum(xs: +List<Nat>) -> Nat:
  match xs:
    case Nil{}:
      0n
    case x <> tail:
      Nat.add(x, sum(tail))

def add(xs: +List<Nat>, ys: +List<Nat>) -> +List<Nat>:
  match xs ys:
    case Nil{} _:
      ys
    case x <> tail Nil{}:
      x <> tail
    case x <> xt y <> yt:
      Nat.add(x, y) <> add(xt, yt)

# Repeated vector addition is scalar multiplication over naturals. It makes
# the proof independent of machine multiplication and numerical tolerances.
def scale(mass: Nat, +weights: +List<Nat>) -> +List<Nat>:
  match mass:
    case 0n:
      Nil{}
    case 1n+p:
      add(weights, scale(p, weights))

type Column is Data:
  Source{mass: Nat, weights: +List<Nat>}

def input_mass(columns: +List<Column>) -> Nat:
  match columns:
    case Nil{}:
      0n
    case Source{mass, weights} <> tail:
      Nat.add(mass, input_mass(tail))

def transport(columns: +List<Column>) -> +List<Nat>:
  match columns:
    case Nil{}:
      Nil{}
    case Source{mass, weights} <> tail:
      add(scale(mass, weights), transport(tail))

# Each source column must carry evidence that its integer weights sum to D.
# With D > 0, weights / D are nonnegative probabilities summing to one.
def Normalized(columns: +List<Column>, +denominator: Nat) -> Type:
  match columns:
    case Nil{}:
      Unit
    case Source{mass, weights} <> tail:
      {sum(weights) == denominator : Nat} & Normalized(tail, denominator)
