// Synthetic Connections port for the direct chat layout fixture.
export const ConnectionsService = {
  listConnectionsPage: async ({ query = "" }: { query?: string }) => {
    const people = [
      { connectionId: "connection-leah", userId: "leah", publicPersonRef: "leah", displayName: "Leah Roy", photoUrl: null, createdAt: null },
      { connectionId: "connection-ravi", userId: "ravi", publicPersonRef: "ravi", displayName: "Ravi Shah", photoUrl: null, createdAt: null },
    ];
    const items = people.filter((person) => person.displayName.toLowerCase().includes(query.toLowerCase()));
    return { items, page: 1, hasMore: false, totalCount: items.length };
  },
};
