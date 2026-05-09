import SNB from './SNB';

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen bg-gray-950 overflow-hidden">
      <SNB />
      <main className="flex-1 overflow-auto">
        {children}
      </main>
    </div>
  );
}