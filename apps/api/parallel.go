package main

import (
	"errors"
	"sync"
)

// parallel runs the fns concurrently and joins their errors. The read-heavy
// handlers (event detail, dashboard, group page) fan their independent
// queries out through this: the database is a network away (Neon), so N
// serial round trips cost N x RTT while a fan-out costs ~1 x RTT. pgxpool
// hands each goroutine its own connection (MaxConns raised in main.go).
// Closures write to their own captured variables - no shared state, so no
// locking beyond the WaitGroup.
func parallel(fns ...func() error) error {
	var wg sync.WaitGroup
	errs := make([]error, len(fns))
	for i, fn := range fns {
		wg.Add(1)
		go func(i int, fn func() error) {
			defer wg.Done()
			errs[i] = fn()
		}(i, fn)
	}
	wg.Wait()
	return errors.Join(errs...)
}
