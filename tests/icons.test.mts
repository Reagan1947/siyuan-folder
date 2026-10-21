import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import {MDI_ICON} from "../src/icons.ts";

const mdi = JSON.parse(readFileSync(new URL("../node_modules/@iconify-json/mdi/icons.json", import.meta.url), "utf8")) as {
    icons: Record<string, {body?: string}>;
};

test("every interface icon is a material design icon", () => {
    for (const id of Object.values(MDI_ICON)) {
        assert.equal(typeof mdi.icons[id]?.body, "string", id);
    }
});
