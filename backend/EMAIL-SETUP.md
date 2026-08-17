# Email deliverability

Reminders send from `Birthday Reminders <birthdays@the-duke.org>`.

## Why not a Gmail address

The first version sent *as* `matthewduke0@gmail.com` through SES. Both test
messages went to spam, and correctly so: Gmail checks whether `gmail.com`
authorises `amazonses.com` to send on its behalf, and it does not. Gmail's
own DMARC policy tells receivers to distrust exactly that pattern, and
there is no fix available, because the DNS for `gmail.com` is not ours.

Sending from a domain we control makes the message authentically ours and
lets us publish the records that prove it.

## Why the-duke.org

Of the five domains in the account it was the only one that is personal,
near-empty (four records), and carrying nothing commercial. `trysula.com`
would have mixed a household utility into a product domain, and
`quikslip.com` has 24 records worth leaving alone.

Note for anyone repeating this on `trysula.com`: its apex TXT record holds
three values and must be merged, never overwritten with UPSERT.
`the-duke.org` had no TXT record at all, so SPF was a clean create.

## DNS (Route53 zone Z050174410VDXUIY8EVFZ)

| Record | Type | Value |
|---|---|---|
| `<token1>._domainkey` | CNAME | `<token1>.dkim.amazonses.com` |
| `<token2>._domainkey` | CNAME | `<token2>.dkim.amazonses.com` |
| `<token3>._domainkey` | CNAME | `<token3>.dkim.amazonses.com` |
| apex | TXT | `v=spf1 include:amazonses.com ~all` |
| `_dmarc` | TXT | `v=DMARC1; p=none; rua=mailto:matthewduke0@gmail.com` |

DKIM is SES Easy DKIM, RSA-2048, rotated by AWS. The three tokens come from
`aws sesv2 create-email-identity` and are also readable via
`get-email-identity`.

## DMARC policy

`p=none` is deliberate. It reports without enforcing, so nothing is
rejected while a brand-new sending domain builds reputation. Worth
tightening to `p=quarantine` after a few months of clean sending.

## SES sandbox

The account is in the SES sandbox: 200 messages/day, and recipients must be
verified identities. For two fixed household recipients that is permanent
and needs no support request. Sending to an unverified address — for
example emailing a birthday wish to a friend — would require production
access, which is why the in-app compose feature still uses EmailJS.

## Verified addresses

- `matthewduke0@gmail.com`
- `msb9519@gmail.com`

## Checking it still works

```sh
aws sesv2 get-email-identity --region us-west-2 --email-identity the-duke.org \
  --query '{dkim:DkimAttributes.Status,verified:VerifiedForSendingStatus}'

aws ses get-send-statistics --region us-west-2   # bounces, complaints, rejects
```

Bounces or complaints climbing is the signal that placement has regressed.
