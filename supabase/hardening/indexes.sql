create index if not exists app_diagnostic_events_item_idx on public.app_diagnostic_events(item_id);
create index if not exists app_diagnostic_events_user_idx on public.app_diagnostic_events(user_id);
create index if not exists support_ticket_messages_author_idx on public.support_ticket_messages(author_id);
create index if not exists support_tickets_assigned_idx on public.support_tickets(assigned_to);
create index if not exists support_tickets_item_idx on public.support_tickets(item_id);
