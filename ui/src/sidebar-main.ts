// The sidebar page's shell: styles in the page head at once, everything else loaded lazily.
import "./styles/tokens.css";
import "./styles/app.css";

void import("./boot").then((m) => m.boot("sidebar"));
