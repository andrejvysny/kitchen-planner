import { createContext, useContext, type ReactElement, type ReactNode } from 'react';
import type { AppServices } from '../../app/services';
import type { CommandRegistry } from '../../editor/commands/registry';
import type { EditorState } from '../../editor/editorState';
import type { Store } from '../../model/store';

/**
 * The React side of the composition boundary: components read the app's object
 * graph from here instead of importing singletons out of src/app/bootstrap.
 *
 * Why bother, given there is exactly one app? Because the alternative scales
 * badly in one specific way: every new editor service (a ToolManager, an
 * InputRouter, a SnapEngine) would otherwise become one more bootstrap export
 * and one more direct import in every component that needs it, and the whole
 * tree would keep knowing WHERE the app is constructed. One context, one
 * hook, and a component that needs a new service just asks for it.
 *
 * The import above is TYPE-ONLY and stays that way: src/app imports this
 * directory's StoreBridge, so a value import here would close a module cycle.
 *
 * The provider's value is the module-stable services object, so this context
 * never causes a re-render — <App/> holds no state either, exactly as before.
 */
const ServicesContext = createContext<AppServices | null>(null);

export function AppServicesProvider({
  services,
  children,
}: {
  services: AppServices;
  children: ReactNode;
}): ReactElement {
  return <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>;
}

/** The whole bundle. Throws outside the provider — a wiring bug, not a state. */
export function useAppServices(): AppServices {
  const services = useContext(ServicesContext);
  if (!services) throw new Error('useAppServices() called outside <AppServicesProvider>');
  return services;
}

/* The three narrow readers below are sugar for the overwhelmingly common
 * cases. They exist so a component that only wants the store does not have to
 * name the bundle. */

export function useStore(): Store {
  return useAppServices().store;
}

export function useEditor(): EditorState {
  return useAppServices().editor;
}

export function useCommands(): CommandRegistry {
  return useAppServices().commands;
}
