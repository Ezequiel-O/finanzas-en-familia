// src/modules/savings/Savings.jsx
import React, { useState, useMemo } from 'react';

import { Card } from '../../components/ui/card.jsx';
import { SectionTitle } from '../../components/ui/SectionTitle.jsx';
import { Money } from '../../components/ui/money.jsx';
import { Progress } from '../../components/ui/Progress.jsx';

export function Savings({ data, actions, monthKeyStr, budgetCutDay }) {
  const savings = data?.savings || [];

  const [form, setForm] = useState({ name: '', goal: '', saved: '' });

  async function addSaving(e) {
    e.preventDefault();
    const s = {
      name: form.name || 'Ahorro',
      goal: Number(form.goal || 0),
      saved: Number(form.saved || 0),
      createdAt: Date.now(),
    };
    await actions.addSaving(s);
    setForm({ name: '', goal: '', saved: '' });
  }

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card>
        <SectionTitle>Nueva meta de ahorro</SectionTitle>
        <form onSubmit={addSaving} className="grid gap-3">
          <input
            className="border rounded-lg p-2"
            placeholder="Nombre (ej. Fondo de emergencia)"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <input
            className="border rounded-lg p-2"
            type="number"
            min={0}
            step="1"
            placeholder="Meta (CLP)"
            value={form.goal}
            onChange={(e) => setForm({ ...form, goal: e.target.value })}
          />
          <input
            className="border rounded-lg p-2"
            type="number"
            min={0}
            step="1"
            placeholder="Ahorro inicial (CLP)"
            value={form.saved}
            onChange={(e) => setForm({ ...form, saved: e.target.value })}
          />
          <button className="px-3 py-2 rounded-xl border bg-gray-900 text-white">
            Agregar meta
          </button>
        </form>
      </Card>

      <Card className="lg:col-span-2">
        <SectionTitle>Metas</SectionTitle>
        <div className="space-y-3">
          {savings.map((s) => {
            const pct = s.goal > 0 ? (s.saved / s.goal) * 100 : 0;
            return (
              <div
                key={s.id || s.name + s.goal}
                className="border rounded-xl p-3"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium">{s.name}</div>
                    <div className="text-sm text-gray-600">
                      Ahorrado: <Money n={s.saved} /> / Meta:{' '}
                      <Money n={s.goal} />
                    </div>
                  </div>
                  <div className="w-56">
                    <Progress value={pct} mode="good" />
                    <div className="text-xs text-gray-600 mt-1">
                      Completado: {pct.toFixed(1)}%
                    </div>
                  </div>
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    step="1"
                    placeholder="Aporte (CLP)"
                    className="border rounded-lg p-2"
                    id={`sav-${s.id}`}
                  />
                  <button
                    className="px-3 py-2 rounded-xl border"
                    onClick={async () => {
                      const el = document.getElementById(`sav-${s.id}`);
                      const amt = Number(el?.value || 0);
                      if (amt <= 0) return;
                      await actions.updateSaving(s.id, {
                        saved: Number(s.saved || 0) + amt,
                      });
                      if (el) el.value = '';
                    }}
                  >
                    Registrar aporte
                  </button>
                  <button
                    className="ml-auto text-red-600"
                    onClick={() => actions.removeSaving(s.id)}
                  >
                    Eliminar
                  </button>
                </div>
              </div>
            );
          })}
          {savings.length === 0 && (
            <div className="text-gray-500">Sin metas registradas.</div>
          )}
        </div>
      </Card>
    </div>
  );
}
