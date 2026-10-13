import type { Experiment } from "@furca/core/experiments/Experiment";
import type { MetricResult } from "@furca/core/results/ExperimentResult";
import { useTranslation } from "react-i18next";
import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { VariationSwatch, variationColor } from "~/components/experiments/parts";
import { intlLocale } from "~/i18n";
import { formatCi, formatCount, formatLift } from "./format";

const shortDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString(intlLocale(), { month: "short", day: "numeric", timeZone: "UTC" });

/** Cumulative relative lift by first-exposure date, one line + interval band per treatment */
export function LiftChart({ experiment, result }: { experiment: Experiment; result: MetricResult }) {
  const { t } = useTranslation("results");
  const treatments = experiment.variations.map((v, index) => ({ ...v, index })).slice(1);
  const rows = result.timeseries.map((p) => {
    const row: Record<string, unknown> = { date: p.date, users: p.users };
    for (const c of p.comparisons) {
      row[`lift:${c.variationKey}`] = c.lift;
      row[`ci:${c.variationKey}`] = c.ci;
    }
    return row;
  });

  // Early days have huge intervals; scale to the latest interval so the current estimate stays readable
  const last = result.timeseries.at(-1)?.comparisons ?? [];
  const reach = Math.max(0.05, ...last.flatMap((c) => (c.ci === null ? [] : c.ci.map(Math.abs))), ...result.timeseries.flatMap((p) => p.comparisons.map((c) => Math.abs(c.lift ?? 0))));
  const step = [0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2].find((x) => (reach * 1.3) / x <= 3) ?? 5;
  const cap = Math.ceil((reach * 1.3) / step) * step;
  const ticks = Array.from({ length: Math.round((2 * cap) / step) + 1 }, (_, i) => Number((-cap + i * step).toFixed(4)));

  if (rows.length < 2) {
    return (
      <p className="px-5 py-10 text-center text-body text-muted">
        {t("chart.tooFewDays")}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3 px-2 pt-4 pb-2 sm:px-4">
      {treatments.length > 1 && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 px-3 text-meta text-muted" aria-label={t("chart.legend")}>
          {treatments.map((t) => (
            <li key={t.key} className="inline-flex items-center gap-1.5">
              <VariationSwatch index={t.index} />
              {t.name}
            </li>
          ))}
        </ul>
      )}
      <div className="h-64" aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--separator)" />
            <XAxis
              dataKey="date"
              tickFormatter={shortDate}
              tick={{ fill: "var(--muted)", fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: "var(--border)" }}
              minTickGap={24}
            />
            <YAxis
              domain={[-cap, cap]}
              ticks={ticks}
              allowDataOverflow
              tickFormatter={(v: number) => (Math.abs(v) < 1e-9 ? "0%" : `${v > 0 ? "+" : "\u2212"}${Number(Math.abs(v * 100).toPrecision(2))}%`)}
              tick={{ fill: "var(--muted)", fontSize: 11, fontFamily: "var(--font-mono)" }}
              tickLine={false}
              axisLine={false}
              width={56}
            />
            <ReferenceLine y={0} stroke="var(--muted)" strokeDasharray="3 3" />
            {treatments.map((t) => (
              <Area
                key={`band:${t.key}`}
                dataKey={`ci:${t.key}`}
                stroke="none"
                fill={variationColor(t.index)}
                fillOpacity={0.14}
                isAnimationActive={false}
                connectNulls
              />
            ))}
            {treatments.map((t) => (
              <Line
                key={`line:${t.key}`}
                dataKey={`lift:${t.key}`}
                stroke={variationColor(t.index)}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface)" }}
                isAnimationActive={false}
                connectNulls
              />
            ))}
            <Tooltip
              cursor={{ stroke: "var(--border)" }}
              content={({ active, label }) => {
                const row = rows.find((r) => r.date === label);
                if (!active || row === undefined) return null;
                return (
                  <div className="min-w-48 rounded-md border border-border bg-overlay px-3 py-2 text-meta shadow-overlay">
                    <div className="mb-1 font-medium">
                      {shortDate(String(label))} · {t("users", { count: Number(row.users), users: formatCount(Number(row.users)) })}
                    </div>
                    {treatments.map((t) => {
                      const lift = row[`lift:${t.key}`] as number | null | undefined;
                      const ci = row[`ci:${t.key}`] as [number, number] | null | undefined;
                      return (
                        <div key={t.key} className="flex items-center justify-between gap-4 font-mono tabular">
                          <span className="inline-flex items-center gap-1.5 font-sans">
                            <VariationSwatch index={t.index} />
                            {t.name}
                          </span>
                          <span>
                            {lift == null ? "–" : formatLift(lift)} <span className="text-muted">{ci == null ? "" : formatCi(ci)}</span>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                );
              }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <details className="group px-3 pb-2 text-meta">
        <summary className="cursor-pointer select-none text-muted outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus">
          {t("chart.showTable")}
        </summary>
        <div className="mt-2 max-h-64 overflow-auto">
          <table className="w-full font-mono tabular">
            <thead className="text-muted">
              <tr className="[&>th]:py-1 [&>th]:pr-4 [&>th]:text-left [&>th]:font-normal">
                <th scope="col" className="font-sans">{t("chart.firstExposure")}</th>
                <th scope="col" className="font-sans">{t("chart.users")}</th>
                {treatments.map((t) => (
                  <th key={t.key} scope="col" className="font-sans">
                    {t.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.timeseries.map((p) => (
                <tr key={p.date} className="border-t border-border [&>td]:py-1 [&>td]:pr-4">
                  <td>{p.date}</td>
                  <td>{formatCount(p.users)}</td>
                  {treatments.map((t) => {
                    const c = p.comparisons.find((x) => x.variationKey === t.key);
                    return (
                      <td key={t.key}>
                        {c?.lift == null ? "–" : formatLift(c.lift)} {c?.ci == null ? "" : formatCi(c.ci)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
