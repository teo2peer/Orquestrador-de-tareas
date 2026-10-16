import { describe, expect, test } from 'bun:test';
import { render } from 'ink';
import { PassThrough } from 'node:stream';
import React from 'react';
import { KeymapProvider, useFocusState } from './keymap.tsx';
import { TextArea, TextField } from './widgets.tsx';

const h = React.createElement;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');

function mount(el: React.ReactElement) {
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
  let out = '';
  stdout.on('data', (d) => (out += String(d)));
  const inst = render(el, { stdin: stdin as never, stdout: stdout as never, stderr: stdout as never, exitOnCtrlC: false, patchConsole: false, debug: true });
  const press = async (s: string, wait = 30) => (stdin.write(s), await sleep(wait));
  return { press, frame: () => strip(out.split('\x1b[2J').at(-1) ?? out), clear: () => (out = ''), unmount: () => inst.unmount() };
}

type Box = { value: string };

function Field({ box, multi }: { box: Box; multi: boolean }) {
  const [value, setValue] = React.useState(box.value);
  const { setFocused } = useFocusState();
  box.value = value;
  React.useEffect(() => setFocused('f'), []);
  return multi ? h(TextArea, { id: 'f', value, onChange: setValue, width: 30, rows: 3 }) : h(TextField, { id: 'f', value, onChange: setValue, width: 30 });
}

const app = (box: Box, multi = true) => h(KeymapProvider, { children: h(Field, { box, multi }) });

describe('<TextArea>', () => {
  test('a long text scrolls, follows the cursor and shows «líneas a–b de n»', async () => {
    const box = { value: '' };
    const t = mount(app(box));
    await sleep(30);
    await t.press(['uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis'].join('\n'));
    let f = t.frame();
    expect(f).toContain('seis');
    expect(f).not.toContain('uno');
    expect(f).toContain('líneas 4–6 de 6');
    for (let i = 0; i < 5; i++) await t.press('\x1b[A');
    f = t.frame();
    expect(f).toContain('uno');
    expect(f).toContain('líneas 1–3 de 6');
    // ↑ on the first row stays in the field: typing still edits.
    await t.press('\x1b[A');
    await t.press('X');
    expect(box.value.startsWith('unoX\ndos')).toBe(true);
    t.unmount();
  });

  test('editing keys reach the value: ⌥⌫, Ctrl+W, Ctrl+K, Supr', async () => {
    const box = { value: '' };
    const t = mount(app(box, false));
    await sleep(30);
    await t.press('hola mundo cruel');
    await t.press('\x17'); // Ctrl+W
    expect(box.value).toBe('hola mundo ');
    await t.press('\x1b\x7f'); // ⌥⌫
    expect(box.value).toBe('hola ');
    await t.press('\x01'); // Ctrl+A
    await t.press('\x1b[3~'); // Supr: forward
    expect(box.value).toBe('ola ');
    await t.press('\x0b'); // Ctrl+K
    expect(box.value).toBe('');
    t.unmount();
  });
});
