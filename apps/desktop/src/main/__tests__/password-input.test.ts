/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import {
  AstryxLocaleProvider,
  LocaleProvider,
  ToastProvider,
} from "@maka/ui";
import { PasswordInput } from "../../renderer/settings/password-input.js";

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  HTMLElement: globalThis.HTMLElement,
  Node: globalThis.Node,
  Event: globalThis.Event,
  IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT,
};

let mountedRoot: Root | undefined;

afterEach(async () => {
  if (mountedRoot) await act(() => mountedRoot?.unmount());
  mountedRoot = undefined;
  Object.assign(globalThis, originalGlobals);
});

test("mouse focus moving from the password draft to Eye does not commit and Eye reveals it", async () => {
  const harness = await renderPasswordInputs();
  const input = harness.document.querySelector("input") as HTMLInputElement;
  const show = harness.document.querySelector(
    'button[aria-label="Show"]',
  ) as HTMLButtonElement;
  assert.ok(input);
  assert.ok(show);

  harness.focusExit(input, show);
  assert.equal(harness.exits, 0);
  await act(async () => show.click());
  assert.equal(input.type, "text");
  assert.equal(input.value, "complete-secret");
});

test("keyboard focus stays inside through Eye and commits once when Tab leaves the group", async () => {
  const harness = await renderPasswordInputs();
  const input = harness.document.querySelector("input") as HTMLInputElement;
  const show = harness.document.querySelector(
    'button[aria-label="Show"]',
  ) as HTMLButtonElement;
  const outside = harness.document.querySelector("#outside") as HTMLButtonElement;

  harness.focusExit(input, show);
  assert.equal(harness.exits, 0);
  harness.focusExit(show, outside);
  assert.equal(harness.exits, 1);
});

test("proxy password can hide Copy while ordinary password inputs keep it by default", async () => {
  const harness = await renderPasswordInputs();
  const copyButtons = harness.document.querySelectorAll(
    'button[aria-label="Copy"]',
  );

  assert.equal(copyButtons.length, 1);
});

async function renderPasswordInputs(): Promise<{
  document: Document;
  readonly exits: number;
  focusExit(from: Element, to: Element): void;
}> {
  const { document, window } = parseHTML(
    '<div id="root"></div><button id="outside">outside</button>',
  );
  Object.assign(globalThis, {
    document,
    window,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    Event: window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);
  mountedRoot = root;
  let exits = 0;
  await act(async () => {
    root.render(
      createElement(LocaleProvider, {
        locale: "en",
        children: createElement(AstryxLocaleProvider, {
          children: createElement(ToastProvider, {
            children: createElement("div", {},
              createElement(PasswordInput, {
                value: "complete-secret",
                onChange() {},
                onFocusExit: () => {
                  exits += 1;
                },
                hasCopyAction: false,
                label: "Proxy password",
              }),
              createElement(PasswordInput, {
                value: "ordinary-secret",
                onChange() {},
                label: "Ordinary password",
              }),
            ),
          }),
        }),
      }),
    );
  });

  const group = [...container.querySelectorAll("*")].find((element) => {
    const props = reactProps(element);
    return typeof props.onBlurCapture === "function";
  });
  assert.ok(group, "missing InputGroup focus boundary");
  return {
    document: document as unknown as Document,
    get exits() {
      return exits;
    },
    focusExit(_from, to) {
      const handler = reactProps(group).onBlurCapture as (event: {
        currentTarget: Element;
        relatedTarget: Element;
      }) => void;
      handler({ currentTarget: group, relatedTarget: to });
    },
  };
}

function reactProps(element: Element): Record<string, unknown> {
  const key = Object.keys(element).find((candidate) =>
    candidate.startsWith("__reactProps$"),
  );
  return key
    ? ((element as unknown as Record<string, unknown>)[key] as Record<string, unknown>)
    : {};
}
