/**
 * Cookie-banner rules for the common consent platforms, in the spirit of Consent-O-Matic and
 * DuckDuckGo's autoconsent, written from each platform's current markup. Every click target is a
 * reject, deny, "necessary only" or "save" control; no rule names an accept control, and the engine
 * also refuses any element whose text reads as accepting.
 */

export type Target = {
  /** CSS selector for the control. */
  readonly selector: string;
  /** Case-insensitive pattern the control's text must match. */
  readonly text?: string;
  /** Only look inside elements matching this selector. */
  readonly within?: string;
};

export type Step = {
  /** The first visible, non-accepting match among these is clicked. */
  readonly click?: readonly Target[];
  /** Unchecks every checked, enabled checkbox matching this selector. */
  readonly uncheck?: string;
  /** A missing optional step is skipped instead of ending the route. */
  readonly optional?: boolean;
};

export type CmpRule = {
  readonly name: string;
  /** A visible element matching this means the banner is showing. */
  readonly detect: string;
  /** The banner lives in this element's shadow root (open or closed). */
  readonly shadowHost?: string;
  /** Tried in order: the first route whose first step can start now is run. */
  readonly routes: readonly (readonly Step[])[];
};

const REJECT_TEXT = "reject|decline|deny|disagree|refuse|do not consent|ablehnen|refuser|rechazar|rifiuta|weigeren";

export const CMP_RULES: readonly CmpRule[] = [
  {
    name: "OneTrust",
    detect: "#onetrust-banner-sdk",
    routes: [
      [{ click: [{ selector: "#onetrust-reject-all-handler" }] }],
      [
        { click: [{ selector: "#onetrust-pc-btn-handler" }] },
        { click: [{ selector: "#onetrust-pc-sdk .ot-pc-refuse-all-handler" }], optional: true },
        { uncheck: "#onetrust-pc-sdk input[type=checkbox]" },
        { click: [{ selector: "#onetrust-pc-sdk .save-preference-btn-handler" }] },
      ],
    ],
  },
  {
    name: "Cookiebot",
    detect: "#CybotCookiebotDialog",
    routes: [
      [
        {
          click: [{ selector: "#CybotCookiebotDialogBodyButtonDecline" }, { selector: "#CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll" }],
        },
      ],
    ],
  },
  {
    name: "Didomi",
    detect: "#didomi-notice",
    routes: [
      [{ click: [{ selector: "#didomi-notice-disagree-button" }, { selector: ".didomi-continue-without-agreeing" }] }],
      [
        { click: [{ selector: "#didomi-notice-learn-more-button" }] },
        { click: [{ selector: "button", text: "disagree to all|refuse all|reject all|tout refuser|alle ablehnen", within: "#didomi-popup" }] },
        { click: [{ selector: "button", text: "^\\s*(save|enregistrer|speichern|guardar)", within: "#didomi-popup" }], optional: true },
      ],
    ],
  },
  {
    name: "Quantcast",
    detect: ".qc-cmp2-summary-buttons",
    routes: [
      [{ click: [{ selector: "button", text: REJECT_TEXT, within: ".qc-cmp2-summary-buttons" }] }],
      [
        { click: [{ selector: "button", text: "more options|manage|options", within: ".qc-cmp2-summary-buttons" }] },
        { click: [{ selector: "button", text: "reject all|disagree to all|object all", within: ".qc-cmp2-container" }], optional: true },
        { click: [{ selector: "button", text: "save|exit", within: ".qc-cmp2-footer" }] },
      ],
    ],
  },
  {
    name: "TrustArc",
    detect: "#truste-consent-track",
    routes: [[{ click: [{ selector: "#truste-consent-required" }] }]],
  },
  {
    name: "Usercentrics",
    detect: "[data-testid=uc-default-banner], [data-testid=uc-banner-content], #uc-center-container",
    shadowHost: "#usercentrics-root",
    routes: [
      [{ click: [{ selector: "[data-testid=uc-deny-all-button]" }] }],
      [{ click: [{ selector: "[data-testid=uc-more-button]" }] }, { click: [{ selector: "[data-testid=uc-deny-all-button]" }] }],
    ],
  },
  {
    name: "Usercentrics",
    detect: "#uc-main-dialog, .cmp-wrapper, [role=dialog]",
    shadowHost: "#usercentrics-cmp-ui",
    routes: [[{ click: [{ selector: "#deny" }, { selector: "button.deny" }, { selector: "button", text: `^\\s*(${REJECT_TEXT})` }] }]],
  },
  {
    // Runs inside Sourcepoint's message iframe (the content script runs in every frame).
    // Choice type 13 is "reject all"; 11 is "accept all" and is never touched.
    name: "Sourcepoint",
    detect: "[class*=sp_choice_type]",
    routes: [[{ click: [{ selector: ".sp_choice_type_13" }, { selector: ".sp_choice_type_REJECT_ALL" }] }]],
  },
  {
    name: "Google Funding Choices",
    detect: ".fc-consent-root .fc-dialog",
    routes: [
      [{ click: [{ selector: ".fc-cta-do-not-consent" }] }],
      [{ click: [{ selector: ".fc-cta-manage-options" }] }, { click: [{ selector: ".fc-confirm-choices" }] }],
    ],
  },
  { name: "CookieYes", detect: ".cky-consent-container", routes: [[{ click: [{ selector: ".cky-btn-reject" }] }]] },
  { name: "Complianz", detect: ".cmplz-cookiebanner", routes: [[{ click: [{ selector: ".cmplz-cookiebanner .cmplz-deny" }] }]] },
  { name: "Osano", detect: ".osano-cm-dialog", routes: [[{ click: [{ selector: ".osano-cm-denyAll" }] }]] },
  { name: "iubenda", detect: "#iubenda-cs-banner", routes: [[{ click: [{ selector: ".iubenda-cs-reject-btn" }] }]] },
  { name: "Axeptio", detect: "#axeptio_overlay", routes: [[{ click: [{ selector: "#axeptio_btn_dismiss" }] }]] },
  { name: "Termly", detect: "[data-tid=banner-decline]", routes: [[{ click: [{ selector: "[data-tid=banner-decline]" }] }]] },
];

export const CMP_NAMES: readonly string[] = [...new Set(CMP_RULES.map((r) => r.name))];

/** Text that reads as giving consent. */
export const ACCEPT_TEXT = /\b(accept|agree|allow|consent|ok|okay|got it|i understand|akzeptieren|zustimmen|einverstanden|accepter|j'accepte|aceptar|accetta|accetto)\b/i;
/** Text that reads as refusing, limiting or saving a choice. */
export const REFUSE_TEXT =
  /\b(reject|decline|deny|disagree|refuse|do not consent|don't consent|necessary|essential|required|only|continue without|save|confirm (my )?choices|ablehnen|refuser|rechazar|rifiuta|weigeren)\b/i;

/** The last line of defence: never click something that reads as accepting unless it also reads as refusing. */
export function isSafeToClick(text: string): boolean {
  const clean = text.replace(/\s+/g, " ").trim();
  return !ACCEPT_TEXT.test(clean) || REFUSE_TEXT.test(clean);
}
