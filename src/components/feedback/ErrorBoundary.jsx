// src/components/feedback/ErrorBoundary.jsx
import React from 'react';

// Evita que un error en una pestaña deje la app en blanco.
// No muestra detalles técnicos al usuario; el detalle queda solo en la consola.
export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    console.error('Error de interfaz', { error, componentStack: info?.componentStack });
  }

  componentDidUpdate(prevProps) {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false });
    }
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-1)] p-6 text-center space-y-3">
        <div className="text-base font-semibold">Algo salió mal en esta sección</div>
        <p className="text-sm text-[color:var(--text-muted)]">
          Tus datos están a salvo. Prueba recargar o cambiar de pestaña.
        </p>
        <button
          type="button"
          className="min-h-[44px] px-4 rounded-xl bg-[color:var(--primary)] text-[color:var(--primary-contrast)] text-sm font-semibold"
          onClick={() => window.location.reload()}
        >
          Recargar
        </button>
      </div>
    );
  }
}
