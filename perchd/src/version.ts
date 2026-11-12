/** Perch's version, from the repository's version.json; bun build inlines it into the binary. */
import info from "../../version.json";

export const PERCH_VERSION: string = info.perch;
