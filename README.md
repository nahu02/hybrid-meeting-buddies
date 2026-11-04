# The Galene videoconferencing system

Galene is a fully-featured videoconferencing system that is easy to deploy
and requires very moderate server resources.  It is described at
<https://galene.org>.

## Hybrid meeting buddies

This fork extends Galene with a *hybrid meeting buddy* system: a physical
meeting room is equipped with a conferencing TV (the **leader**) and one
or more phones (the **buddy devices**), each of which represents one
**remote participant** inside the room.  Clients choose their role from
a dropdown on the login page (remote participant, buddy device or
leader); the choice is reflected in the page URL as a query parameter,
so reloading the page or sharing the link keeps the role, e.g.

    https://server/group/meeting/?role=leader

The role, together with any other query parameters except `token`, is
sent to the server as the client's join `data`.  The role never changes
after joining; the other data fields may change during the meeting (via
the `setdata` user action, which triggers server-side re-filtering of
all streams).

### Client data fields

| key          | meaning                                                                     | usage                                                                       | value                                                                        |
| ------------ | --------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `role`       | what kind of device the client is in the hybrid buddy system                | *required*; client sets it at join; never changes after                      | `leader` / `buddyDevice` / `remote`                                          |
| `audioRoute` | whether the assigned remote participant gets audio from, and voice is routed to, the assigned buddy device or the leader | client (with `role: 'buddyDevice'`) sets it via `setdata`                    | `leader` (default) / `local`                                                 |
| `assignedTo` | the buddy device / remote participant the client is buddies with            | server sets it as soon as an assignment happens; clients must be prepared for this not being set; never set for `leader` | id of one of the clients or `undefined` |

### Meeting flow

1. **Before assignment** — everyone joins with their role.  The server
   filters the streams per role (see the tables below), so no client ever
   receives a feed it shouldn't see.
2. **Starting assignments** — the leader presses *Start assignments*.
   The server clears every client's `assignedTo` and sends every remote
   and buddy device an `openUrl` message pointing at the assignment
   interface (a new tab; the browser requires a tap on the toast to open
   it, since popups may not be opened automatically).
3. **Assignment** — the assignment interface pairs remote participants
   with buddy devices; the server sets both clients' `assignedTo`.
4. **After assignment** — participants return to the original tab, where
   the new view has already taken place: the server re-filters the streams
   as soon as `assignedTo` changes, and the client UI switches to the
   role-specific view.

### Views: before assignment

| Participant                     | Video views                                                              | Audio                                                                                     | Buttons                                       |
| ------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | --------------------------------------------- |
| Leader (conferencing TV)         | Grid of all remote participants and themselves; buddy devices are never shown | Conventional: hears all remote participants; room mic is sent to everyone                  | Existing buttons + *Start assignments*        |
| Buddy device (phone in the room) | None                                                                      | None on the phone; all audio is routed via the leader machine                              | Existing buttons only                         |
| Remote participant               | Grid of other remote participants, the leader and themselves              | Conventional: full-duplex audio with everyone                                             | Existing buttons only                         |

### Views: after assignment

| Participant                            | Video views                                                                                                | Audio                                                                                                                                                   | Buttons                                                                                       |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Leader (not part of the assignment)    | Only their own camera feed, the conferencing camera that captures the whole room; remote participants' video tiles are no longer shown (buddy devices never were) | Remote participants' voices keep playing on the TV, unless a buddy device switched its audio route to `local` (then that remote is silent on the TV)     | Existing buttons + *Start assignments*                                                        |
| Buddy device with an assigned remote   | Full-screen video feed of the assigned remote participant, with a small self-preview                        | `leader` (default): no meeting audio on the phone.  `local`: the phone plays the assigned remote's voice and streams the room audio to them               | *Audio route* toggle (leader ↔ local); *camera flip* (front/back), tied to the self-preview   |
| Remote participant assigned to a buddy | Other remote participants, their own preview, and the feed from their buddy device (the physical room); the leader's video is no longer shown | `leader` (default): hears the room via the leader's mic, own voice played by the TV.  `local`: hears the room via the buddy device, own voice played by it | Existing buttons only                                                                          |

Remote participants without a buddy (not enough buddy devices, or before
their assignment) keep the pre-assignment view.

## Quick start

```sh
git clone https://github.com/jech/galene
cd galene
CGO_ENABLED=0 go build -ldflags='-s -w'
mkdir groups
echo '{"users": {"vimes": {"password":"sybil", "permissions":"op"}}}' > groups/night-watch.json
./galene &
```

Point your browser at <https://localhost:8443/group/night-watch/>, ignore
the unknown certificate warning, and log in with username *vimes* and
password *sybil*.

For full installation instructions, please see the file [galene-install.md][1]
in this directory.

## Documentation

  * [galene-install.md][1]: full installation instructions
  * [galene.md][2]: usage and administration;
  * [galene-client.md][3]: writing clients;
  * [galene-protocol.md][4]: the client protocol;
  * [galene-api.md][5]: Galene's administrative API.
  
## Contributing

In order to contribute to Galene, you may:

  * send patches to [the Galene mailing list][6] by sending mail to
    <galene@lists.galene.org>;
  * submit pull requests on GitHub.

For general discussion, please use the [Galene mailing list][6] (feel free
to send mail without subscribing).  Please do not use Github for general
discussion.

## Further information

Galène's web page is at <https://galene.org>.

Answers to common questions and issues are at <https://galene.org/faq.html>.


-- Juliusz Chroboczek <https://www.irif.fr/~jch/>

[1]: <galene-install.md>
[2]: <galene.md>
[3]: <galene-client.md>
[4]: <galene-protocol.md>
[5]: <galene-api.md>
[6]: <https://lists.galene.org/>
