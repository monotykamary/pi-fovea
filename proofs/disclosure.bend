import Base

# Only candidate admission lives here. Heat eligibility, set membership,
# ordering, formatting, and state updates remain TypeScript boundary concerns.
type Decision is Data:
  Drop{}
  Suppress{}
  Reveal{}

def disclosure(in_scope: Bool, excluded: Bool, seen: Bool, repeat: Bool, nucleus: Bool) -> Decision:
  match in_scope:
    case False{}:
      Drop{}
    case True{}:
      match excluded:
        case True{}:
          Drop{}
        case False{}:
          match seen:
            case False{}:
              Reveal{}
            case True{}:
              match repeat:
                case False{}:
                  Suppress{}
                case True{}:
                  match nucleus:
                    case False{}:
                      Suppress{}
                    case True{}:
                      Reveal{}
