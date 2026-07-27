import { assertOnCleanUpToDateMain } from "./release-git";

assertOnCleanUpToDateMain("A release");
console.log("Release preflight passed: on main, clean, up to date with origin/main.");
