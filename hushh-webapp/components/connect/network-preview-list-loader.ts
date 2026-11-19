export type NetworkListComponent = typeof import("./network-people-list").NetworkPeopleList;

let listComponent: NetworkListComponent | undefined;
let listLoad: Promise<{ default: NetworkListComponent }> | undefined;

export function loadNetworkPreviewList() {
  listLoad ??= import("./network-people-list").then(module => {
    listComponent = module.NetworkPeopleList;
    return { default: listComponent };
  }, error => {
    listLoad = undefined;
    throw error;
  });
  return listLoad;
}

export function preloadedNetworkPreviewList() {
  return listComponent;
}
