/** Content script, page world: see src/drm/hook.ts. */
import { installDrmHook } from "../drm/hook";

installDrmHook(window);
