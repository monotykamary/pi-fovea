export function subscribeToUsers(broker: { subscribe: (channel: string, handler: () => void) => void }, handler: () => void) {
  broker.subscribe("users.changed", handler);
}
