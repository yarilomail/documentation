# Other users' mailboxes

A user can open another user's mailboxes under a namespace such as `user/alice/`, when alice's ACL allows it. The namespace is configured once, and yarilo resolves each owner's storage the first time a session names that owner.

For namespaces in general, see [Namespaces](/storage/namespace).

## Configuring the namespace

Add a namespace whose prefix carries the owner variable `%u`:

```yaml
namespaces:
  - type: shared          # or other, for the Other Users slot of NAMESPACE
    prefix: "user/%u/"
    separator: "/"
    location: "maildir:%h"
```

The `%u` in the prefix makes this namespace owner-templated. Inside it, the variables `%h`, `%u`, `%n` and `%d` in `location` stand for the owner of the mailbox, not for the user who is logged in.

yarilo refuses to start, naming the namespace, when an owner-templated entry:

- has no `location`, or a `location` without one of those variables, which would put every owner at one path;
- sets `subscriptions: true` (subscriptions to other users' folders are kept with the subscriber);
- sets `list: yes` (the unexpanded `user/%u` is not a mailbox; leave `list` unset or set `children`);
- has anything after `%u` other than the separator. `user/%u/` works; `user/%n@%d/` does not.

## How an owner's storage is found

When a session names `user/alice/Sent`, yarilo looks alice up in the userdb, exactly as at her own login. Her userdb entry decides the driver and the path. The namespace `location` is used only when the userdb gives no mail location for her.

- The owner segment is only ever a userdb key, never part of a path. An owner who is not in the userdb is a mailbox that does not exist.
- `user/<own name>/…` opens the user's own mailboxes.
- A session keeps up to 64 owners open. Past that one is closed, and naming it again costs one more userdb lookup.

## Access control

The owner has full rights on their own mailboxes, whatever the ACL says, so no ACL entry can lock an owner out.

Anyone else needs ACL rights, as for any shared mailbox:

- `l` to see the mailbox in `LIST`;
- `r` to select it;
- `i` to append and `p` to deliver into it.

A user without `l` gets the same answer as for a mailbox that does not exist, so names in someone else's space cannot be probed. With `l`, the refusal names the missing right.

The first mailbox in an empty space needs the create right granted on the namespace root (`--root` in `yarctl`). Each new mailbox gets an ACL file of its own, copied from its parent, or from the root, when it is created. Later changes to the parent do not reach it.

Within one ACL file, when two lines name the same identifier with the same sign, the later line counts. A malformed line makes the whole file unreadable, and the mailbox refuses access rather than serving part of its ACL.

## Listing other users

`LIST "" "user/*"` shows the owners who have granted the user anything. They are read from a registry kept in the dict that `acl.acl_sharing_map` names; that dict must be in the `dicts` section. Without it `user/*` lists nobody, while a name written out, such as `user/alice/*`, still works.

The registry is re-read once an hour:

- After a `SETACL`, the user it names sees the new owner on their next `LIST` when they are on the same backend, and within an hour on the others.
- `yarctl backend acl registry rebuild <owner> --namespace <prefix>` rewrites an owner's rows and drops every cached answer.
- `yarctl backend acl registry list <user>` reads the registry directly, without the cache.

`NAMESPACE` advertises the prefix as `user/`, which is what a client prepends to an owner's name.

## Delivery

LMTP and Sieve `fileinto` can deliver to `user/alice/<folder>` when the recipient holds `p` on it.

When that delivery cannot be made, the message goes to the recipient's own INBOX and a warning is logged. This covers an unknown owner, a missing right, and storage that cannot be opened. No mail is lost.

## Deployment

The owner's files must be on storage that the backend serving the session mounts.

### Users who share must land on one backend {#routing-within-a-farm-users-who-share-must-land-on-one-backend}

When all backends of a director tag share one volume, any of them can open any owner's files. When each backend has its own storage, the owner's mailbox is simply not on the backend serving the other user. Every share then fails in a way that looks like an ACL fault.

The director hashes the whole address by default (`director_service.username_hash` unset, i.e. `%Lu`), so two users of one domain routinely land on different backends.

If users of one domain share mailboxes with each other, route the domain to one backend:

```yaml
components:
  director:
    assignment_policy: domain   # one backend per domain, picked by load
```

The domain is placed on the backend with the fewest connections, and every user of it follows. The policy does not read `username_hash`.

Hashing the domain does the same and stays supported:

```yaml
components:
  director:
    username_hash: "%Ld"       # hash the domain, not the address
    assignment_policy: hash    # least_sessions never reads the name
```

Both lines are needed: `least_sessions` picks the least-loaded backend and ignores the hash template. The difference is where the domain lands: `hash` decides by name, `domain` by load. The default stays `%Lu`, because hashing a single-domain deployment on `%Ld` puts every account on one backend.

### Owners on another storage shard

Access to an owner whose mailbox is on another director tag, and so on storage this backend does not mount, is not supported.

## What a user sees when access fails

| Situation | IMAP | LMTP |
|:---|:---|:---|
| Owner not in the userdb | `NO`, the mailbox does not exist | recipient's INBOX, warning logged |
| Owner's storage not mounted here | `NO` | recipient's INBOX, warning logged |
| User holds `l` but lacks the right needed | `NO [NOPERM]`, naming the right | recipient's INBOX, warning logged |
| User holds no `l` | `NO [NONEXISTENT]`, as for an absent mailbox | recipient's INBOX, warning logged |
| The owner is the user | the user's own mailboxes | the recipient's own store |
