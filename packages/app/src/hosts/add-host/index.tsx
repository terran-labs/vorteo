import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import { AddHostMethodModal } from "./internal/add-host-method-modal";
import { AddHostModal } from "./internal/add-host-modal";
import { AddRemoteSshHostModal } from "./internal/add-remote-ssh-host-modal";
import { createAddHostFlow, type AddHostOptions, type AddHostSession } from "./internal/model";

const Context = createContext<ReturnType<typeof createAddHostFlow> | null>(null);

/** Owns the flow outside screen and appearance lifetimes. Callers own success navigation. */
export function AddHostProvider({ children }: { children: ReactNode }) {
  const [flow] = useState(createAddHostFlow);
  return <Context.Provider value={flow}>{children}</Context.Provider>;
}

export function AddHostFlowHost() {
  const flow = useContext(Context);
  if (!flow) throw new Error("AddHostFlowHost requires AddHostProvider");
  const session = useStore(flow.store, (state) => state.session);
  return session ? <AddHostSessionView key={session.id} session={session} /> : null;
}

export function useAddHost({ method, onAdded }: AddHostOptions = {}) {
  const flow = useContext(Context);
  if (!flow) throw new Error("useAddHost requires AddHostProvider");
  return useCallback(() => flow.open({ method, onAdded }), [flow, method, onAdded]);
}

function AddHostSessionView({ session }: { session: AddHostSession }) {
  const method = useStore(session.step, (state) => state.method);
  const back = useCallback(() => session.choose(null), [session]);
  const direct = useCallback(() => session.choose("direct"), [session]);
  const ssh = useCallback(() => session.choose("ssh"), [session]);
  return (
    <>
      <AddHostMethodModal
        visible={method === null}
        onClose={session.close}
        onDirectConnection={direct}
        onRemoteSsh={ssh}
      />
      <AddHostModal
        visible={method === "direct"}
        onClose={session.close}
        onCancel={back}
        onSaved={session.complete}
      />
      <AddRemoteSshHostModal
        visible={method === "ssh"}
        onClose={session.close}
        onCancel={back}
        onSaved={session.complete}
      />
    </>
  );
}
