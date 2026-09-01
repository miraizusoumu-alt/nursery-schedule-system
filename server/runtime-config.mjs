export function resolveGatewayPorts(environment = process.env) {
  function port(value, fallback) {
    const selected = value || String(fallback);
    if (!/^\d+$/.test(selected) || Number(selected) < 1 || Number(selected) > 65535) {
      throw new Error("Gateway ports must be integers between 1 and 65535.");
    }
    return Number(selected);
  }
  const publicPort = port(environment.NURSERY_PORT || environment.PORT, 3000);
  const internalPort = port(environment.NURSERY_INTERNAL_PORT, 3100);
  if (publicPort === internalPort) throw new Error("Public and internal gateway ports must be different.");
  return { publicPort, internalPort };
}
