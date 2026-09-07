import React from "react";

export function H1({ children }: { children: React.ReactNode }) {
  return <h1 className="text-2xl font-semibold text-gray-900 mb-2">{children}</h1>;
}
export function H2({ children }: { children: React.ReactNode }) {
  return <h2 className="text-lg font-semibold text-gray-900 mt-10 mb-3 pb-2 border-b border-gray-200">{children}</h2>;
}
export function H3({ children }: { children: React.ReactNode }) {
  return <h3 className="text-base font-semibold text-gray-800 mt-6 mb-2">{children}</h3>;
}
export function P({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-gray-700 leading-relaxed mb-4">{children}</p>;
}
export function Lead({ children }: { children: React.ReactNode }) {
  return <p className="text-base text-gray-600 leading-relaxed mb-6">{children}</p>;
}
export function Code({ children }: { children: React.ReactNode }) {
  return <code className="font-mono text-xs bg-gray-100 text-gray-800 px-1.5 py-0.5 rounded">{children}</code>;
}
export function Ul({ children }: { children: React.ReactNode }) {
  return <ul className="list-disc list-outside ml-5 space-y-1.5 text-sm text-gray-700 mb-4">{children}</ul>;
}
export function Ol({ children }: { children: React.ReactNode }) {
  return <ol className="list-decimal list-outside ml-5 space-y-1.5 text-sm text-gray-700 mb-4">{children}</ol>;
}
export function Li({ children }: { children: React.ReactNode }) {
  return <li className="leading-relaxed">{children}</li>;
}
export function Tip({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-3 bg-blue-50 border border-blue-200 rounded-lg px-4 py-3 mb-4">
      <span className="text-blue-500 shrink-0 mt-0.5">✦</span>
      <p className="text-sm text-blue-800 leading-relaxed">{children}</p>
    </div>
  );
}
export function Warning({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-3 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 mb-4">
      <span className="text-amber-500 shrink-0 mt-0.5">⚠</span>
      <p className="text-sm text-amber-800 leading-relaxed">{children}</p>
    </div>
  );
}
export function Concept({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-3 bg-green-50 border border-green-200 rounded-lg px-4 py-3 mb-4">
      <span className="text-green-500 shrink-0 mt-0.5">✦</span>
      <p className="text-sm text-green-800 leading-relaxed">{children}</p>
    </div>
  );
}
export function SimpleTable({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return (
    <div className="overflow-x-auto mb-6">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="bg-gray-100">
            {headers.map(h => (
              <th key={h} className="text-left text-xs font-semibold text-gray-600 uppercase tracking-wide px-3 py-2 border border-gray-200">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className={i % 2 === 1 ? "bg-gray-50" : "bg-white"}>
              {row.map((cell, j) => (
                <td key={j} className="px-3 py-2 border border-gray-200 text-gray-700 leading-relaxed align-top">{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export function Divider() {
  return <hr className="border-gray-200 my-8" />;
}
