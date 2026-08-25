import assert from "node:assert/strict";

import {
  clipCapturedText,
  createTelemetryEvent,
  selectedTextFromTarget,
} from "../../src/local_board/web/assets/js/assessment-telemetry.js";

assert.equal(clipCapturedText("x".repeat(1200)).length, 1000);

const event = createTelemetryEvent("paste", {
  id: "event-1",
  questionId: "python-09",
  clientTime: 123,
  text: "answer",
});
assert.deepEqual(event, {
  id: "event-1",
  type: "paste",
  question_id: "python-09",
  client_time: 123,
  text: "answer",
  text_length: 6,
  meta: {},
});

assert.equal(
  selectedTextFromTarget({
    value: "middle engineer",
    selectionStart: 0,
    selectionEnd: 6,
  }),
  "middle",
);

console.log("assessment telemetry tests passed");
