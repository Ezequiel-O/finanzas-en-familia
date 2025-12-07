// src/components/ui/SectionTitle.jsx
export function SectionTitle({ children, right }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <h2 className="text-xl font-semibold">{children}</h2>
      {right}
    </div>
  );
}
