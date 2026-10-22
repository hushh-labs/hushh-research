// Synthetic Connections port for the direct chat layout fixture.
export const ConnectionsService = {
  listConnectionsPage: async ({ query = "" }: { query?: string }) => {
    const people = [
      { connectionId: "connection-leah", userId: "leah", publicPersonRef: "leah", displayName: "Leah Roy", photoUrl: null, createdAt: null },
      { connectionId: "connection-maya", userId: "maya", publicPersonRef: "person-maya", displayName: "Maya Rao", photoUrl: null, createdAt: null },
      { connectionId: "connection-arjun", userId: "arjun", publicPersonRef: "arjun", displayName: "Arjun Mehta", photoUrl: null, createdAt: null },
    ];
    const items = people.filter((person) => person.displayName.toLowerCase().includes(query.toLowerCase()));
    return { items, page: 1, hasMore: false, totalCount: items.length };
  },
};

export class PersonProfileService {
  static async getViewer(personRef: string) {
    return { personRef, relationship: { status: "connected" }, contactEmail: null, contactPhoneNumber: null };
  }
}
