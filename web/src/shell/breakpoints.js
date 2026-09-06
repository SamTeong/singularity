// Shell viewport contract — phone `<600px`, tablet `600–899px`, desktop `>=900px`
// (MUI's default breakpoint pixels).
//
// These are literal media queries, not `theme.breakpoints.*`, on purpose: the
// two skins ship different breakpoint values (the vendored ZAPAC theme redefines
// sm/md/lg to 560/720/920 for its bento/rail collapse points; phosphor-console-
// theme keeps MUI's 600/900/1200). Asking the theme would move the phone/tablet
// boundary when the user switches skin, and the shell's navigation contract —
// and the responsive suite's 375/768/1024/1440 matrix — has to be identical
// under both. Feature-internal layout still uses the theme's own breakpoints.
export const PHONE_QUERY = '(max-width:599.95px)';
export const TABLET_QUERY = '(min-width:600px) and (max-width:899.95px)';

// Height, not width — the one viewport decision that cannot be made from the
// table above. A phone held in landscape is 667x375: wide enough that
// `PHONE_QUERY` (width-only, as the plan's viewport table defines it) classes
// it as a tablet, while it has less usable height than any phone in portrait.
// Used only to decide whether a chrome surface may open by default and take
// the page's remaining height (currently the terminal dock).
export const SHORT_QUERY = '(max-height:499.95px)';
