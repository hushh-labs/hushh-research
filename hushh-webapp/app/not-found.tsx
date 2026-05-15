import { redirect } from 'next/navigation';

export default function NotFound() {
  // Server-side redirect to the home page to avoid blank screen flashes
  redirect('/');
}
