/** Component tests run in happy-dom. Loaded with `bun test --preload`, never for the smoke tests. */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost/", width: 1280, height: 800 });
